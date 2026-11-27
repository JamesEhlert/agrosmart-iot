/* AgroSmart V5 (v5.42.0): aplica o tema antes da primeira pintura (sem piscar em branco).
   Mesma regra de src/shared/theme/theme.ts; chave 'agrosmart.theme'. Arquivo externo por causa do CSP. */
(function () {
  var mode = 'light'; /* padrão: DEFAULT_THEME_MODE em theme.ts */
  try { var v = window.localStorage.getItem('agrosmart.theme'); if (v === 'light' || v === 'dark' || v === 'system') mode = v; } catch (e) {}
  var dark = mode === 'dark';
  if (mode === 'system') { try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) {} }
  var root = document.documentElement;
  if (dark) root.classList.add('dark');
  root.style.colorScheme = dark ? 'dark' : 'light';
})();
