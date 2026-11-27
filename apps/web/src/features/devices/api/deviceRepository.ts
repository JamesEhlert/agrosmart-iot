/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/api/deviceRepository.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1 — F1.1, F1.2, F1.4, F1.5)
 * DATA DE ATUALIZAÇÃO: 2026-11-21T02:30:00Z (UTC)
 * VERSÃO: v5.29.0
 * PROPÓSITO: Repositório Firestore para leitura em tempo real (`onSnapshot`) e
 *            gerenciamento Multi-Tenant de estações IoT (`users/{uid}`, `devices/{id}`
 *            para titular e `devices/{id}/demo_view/current` para sessão Demo).
 * CHANGELOG:
 * - v5.29.0:
 *   * `subscribeToDeviceDocument` passa a suportar `{ isDemoView: true }`, assinando
 *     a projeção sanitizada `devices/{deviceId}/demo_view/current` e preservando o
 *     `deviceId` real (em vez de `snapshot.id === 'current'`).
 *   * Removidas escritas diretas do cliente nos campos `settings.demo_*`, agora
 *     bloqueadas por `firestore.rules` v5.29.0 e gerenciadas exclusivamente via backend.
 * =====================================================================================
 */

import {
  arrayRemove,
  arrayUnion,
  doc,
  DocumentData,
  getDoc,
  onSnapshot,
  setDoc,
  Unsubscribe,
  UpdateData,
  updateDoc,
} from 'firebase/firestore';
import { firebaseAuth, firestoreDb } from '../../../shared/config/firebase';
import { parseDeviceFromFirestore } from '../model/device.schema';
import { DeviceModel, DeviceSettings } from '../model/device.types';

/**
 * Escuta em tempo real a lista `my_devices` do usuário autenticado.
 */
export function subscribeToUserDeviceIds(
  uid: string,
  onData: (deviceIds: string[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const userRef = doc(firestoreDb, 'users', uid);
  return onSnapshot(
    userRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onData([]);
        return;
      }
      const data = snapshot.data();
      const rawList = data?.my_devices;
      const ids = Array.isArray(rawList)
        ? rawList.filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          )
        : [];
      onData(ids);
    },
    (err) => {
      if (onError) onError(err);
    },
  );
}

/**
 * Escuta em tempo real o documento da estação:
 * - Operador Titular (`isDemoView = false`): `devices/{deviceId}`;
 * - Usuário Teste (`isDemoView = true`): projeção sanitizada `devices/{deviceId}/demo_view/current`.
 */
export function subscribeToDeviceDocument(
  deviceId: string,
  onData: (device: DeviceModel) => void,
  onError?: (err: Error) => void,
  options?: { isDemoView?: boolean },
): Unsubscribe {
  const isDemoView = Boolean(options?.isDemoView);
  const targetRef = isDemoView
    ? doc(firestoreDb, 'devices', deviceId, 'demo_view', 'current')
    : doc(firestoreDb, 'devices', deviceId);

  return onSnapshot(
    targetRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        onData(parseDeviceFromFirestore(undefined, deviceId));
        return;
      }
      // Preserva explicitamente o deviceId real (evita 'current' na projeção demo_view)
      onData(parseDeviceFromFirestore(snapshot.data(), deviceId));
    },
    (err) => {
      if (onError) onError(err);
    },
  );
}

/**
 * Vincula uma estação ESP32 provisionada à conta do Operador Titular (`owner_uid` + `my_devices`).
 * Respeita estritamente a whitelist de chaves da regra `firestore.rules` v5.29.0.
 */
export async function linkDeviceToCurrentUser(
  deviceId: string,
  initialName: string,
): Promise<void> {
  const user = firebaseAuth.currentUser;
  if (!user) {
    throw new Error('Usuário não autenticado.');
  }

  const cleanId = deviceId.trim();
  const cleanName = initialName.trim() || 'Estação AgroSmart';
  const deviceRef = doc(firestoreDb, 'devices', cleanId);

  try {
    const snap = await getDoc(deviceRef);
    if (!snap.exists()) {
      throw new Error(
        'Estação não encontrada no banco. Verifique se o ID Serial está correto (ex: ESP32-AgroSmart-Station-V5).',
      );
    }

    const existingSettings =
      (snap.data()?.settings as Record<string, unknown> | undefined) ?? {};

    const mergedSettings = {
      target_soil_moisture: Number(existingSettings.target_soil_moisture ?? 60),
      manual_valve_duration: Number(existingSettings.manual_valve_duration ?? 5),
      timezone_offset: Number(existingSettings.timezone_offset ?? -3),
      capabilities: Array.isArray(existingSettings.capabilities)
        ? existingSettings.capabilities
        : ['air', 'soil', 'light', 'rain', 'uv'],
      enable_weather_control: Boolean(
        existingSettings.enable_weather_control ?? false,
      ),
      latitude: Number(existingSettings.latitude ?? 0),
      longitude: Number(existingSettings.longitude ?? 0),
      telemetry_interval_ms: Number(
        existingSettings.telemetry_interval_ms ?? 30000,
      ),
      soil_raw_dry: Number(existingSettings.soil_raw_dry ?? 3000),
      soil_raw_wet: Number(existingSettings.soil_raw_wet ?? 1200),
      device_name: cleanName,
    };

    await setDoc(
      deviceRef,
      {
        device_id: cleanId,
        owner_uid: user.uid,
        settings: mergedSettings,
      },
      { merge: true },
    );
  } catch (err: unknown) {
    const firebaseCode = (err as { code?: string })?.code;
    if (firebaseCode === 'permission-denied') {
      throw new Error(
        'Permissão negada: verifique se o ID Serial está correto ou se a estação já pertence a outra conta.',
      );
    }
    throw err;
  }

  const userRef = doc(firestoreDb, 'users', user.uid);
  await updateDoc(userRef, {
    my_devices: arrayUnion(cleanId),
  });
}

/**
 * Atualiza exclusivamente os parâmetros operacionais permitidos dentro de
 * `devices/{deviceId}.settings` (campos de passe demo são gerenciados via backend).
 */
export async function updateDeviceOperationalSettings(
  deviceId: string,
  newSettings: Partial<DeviceSettings>,
): Promise<void> {
  const deviceRef = doc(firestoreDb, 'devices', deviceId);
  const updatePayload: UpdateData<DocumentData> = {};

  if (newSettings.deviceName !== undefined) {
    updatePayload['settings.device_name'] = newSettings.deviceName.trim();
  }
  if (newSettings.targetMoisture !== undefined) {
    updatePayload['settings.target_soil_moisture'] = newSettings.targetMoisture;
  }
  if (newSettings.manualDuration !== undefined) {
    updatePayload['settings.manual_valve_duration'] = newSettings.manualDuration;
  }
  if (newSettings.timezoneOffset !== undefined) {
    updatePayload['settings.timezone_offset'] = newSettings.timezoneOffset;
  }
  if (newSettings.enableWeatherControl !== undefined) {
    updatePayload['settings.enable_weather_control'] =
      newSettings.enableWeatherControl;
  }
  if (newSettings.latitude !== undefined) {
    updatePayload['settings.latitude'] = newSettings.latitude;
  }
  if (newSettings.longitude !== undefined) {
    updatePayload['settings.longitude'] = newSettings.longitude;
  }

  if (Object.keys(updatePayload).length === 0) {
    return;
  }

  await updateDoc(deviceRef, updatePayload);
}

/**
 * Remove o vínculo da estação da lista `my_devices` do usuário autenticado.
 */
export async function unlinkDeviceFromCurrentUser(
  deviceId: string,
): Promise<void> {
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Usuário não autenticado.');

  const userRef = doc(firestoreDb, 'users', user.uid);
  await updateDoc(userRef, {
    my_devices: arrayRemove(deviceId),
  });
}