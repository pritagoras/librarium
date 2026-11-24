import '../css/style.css';
import { initApp } from './app';

initApp().catch((e) => {
  const main = document.createElement('main');
  const h2 = document.createElement('h2');
  h2.textContent = 'No se pudo iniciar Librarium';
  const p = document.createElement('p');
  p.textContent = 'Probá recargar la página o usar un navegador actualizado.';
  const pre = document.createElement('pre');
  pre.textContent = e instanceof Error ? e.message : String(e);
  main.append(h2, p, pre);
  document.body.replaceChildren(main);
});
