/**
 * Testes da 5.48.0 (última versão da V5): contatos sem e-mail/telefone, aviso do nome
 * e ajustes de celular (MOB-04, MOB-05, MOB-06, MOB-08, MOB-09).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('WEB-548 última versão da V5', () => {
  it('WEB-548-01 versão 5.48.0', () => {
    expect(JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')).version).toBe('5.48.0');
  });
  it('WEB-548-02 sem e-mail nem WhatsApp no site', () => {
    const all = src('features/about/AuthorContact.tsx');
    expect(all).not.toMatch(/mailto:|wa\.me|Mostrar e-mail|Mostrar WhatsApp/);
    expect(all).toContain('data-testid="project-disclaimer"');
  });
  it('WEB-548-03 MOB-04 sensores em 2 colunas no celular', () => {
    expect(src('features/telemetry/components/SensorSummaryGrid.tsx')).toContain('grid grid-cols-2 xl:grid-cols-3');
  });
  it('WEB-548-04 MOB-06 leituras compactas: ícones só a partir de sm', () => {
    const t = src('features/telemetry/components/TelemetryReadingsTable.tsx');
    expect((t.match(/hidden sm:block p-2 rounded-lg/g) ?? []).length).toBe(6);
  });
  it('WEB-548-05 MOB-08 filtros da agenda ocupam a largura no celular', () => {
    const t = src('features/schedules/components/ScheduleList.tsx');
    expect(t).toContain('w-full sm:w-56');
    expect(t).not.toContain('Pausada — não será executada');
  });
  it('WEB-548-06 MOB-09 cabeçalho do cartão de clima empilha no celular', () => {
    expect(src('features/station-settings/components/WeatherGpsCard.tsx')).toContain('flex flex-col sm:flex-row sm:items-center sm:justify-between');
  });
  it('WEB-548-07 MOB-05 banner do clima mostra seta no celular', () => {
    expect(src('features/weather/components/WeatherSummaryBanner.tsx')).toContain('sm:hidden w-5 h-5');
  });
});
