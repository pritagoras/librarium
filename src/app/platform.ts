const $ = <T extends HTMLElement = HTMLElement>(selector: string): T | null =>
  document.querySelector(selector) as T | null;

let installPromptEvent: any = null;

function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const sw = $<HTMLInputElement>('#themeSwitch');
  if (sw) sw.checked = dark;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#242622' : '#f4efe5');
}

export function initTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem('librarium-theme') === 'dark';
  } catch {}
  applyTheme(dark);
  const sw = $<HTMLInputElement>('#themeSwitch');
  if (sw) {
    sw.onchange = (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      applyTheme(checked);
      try {
        localStorage.setItem('librarium-theme', checked ? 'dark' : 'light');
      } catch {}
    };
  }
}

export function initInstall() {
  const button = $<HTMLButtonElement>('#installAppBtn');
  const help = $('#installAppHelp');
  if (!button || !help) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as any).standalone === true;

  const showHelp = () => {
    const ua = navigator.userAgent;
    if (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    ) {
      help.textContent = 'En Safari: Compartir → Añadir a pantalla de inicio.';
    } else if (/android/i.test(ua)) {
      help.textContent =
        'En Chrome: menú ⋮ → Instalar aplicación o Añadir a pantalla de inicio.';
    } else {
      help.textContent = 'Usá la opción Instalar aplicación del menú del navegador.';
    }
  };

  if (standalone) {
    button.textContent = 'Librarium instalada';
    button.disabled = true;
    help.textContent = 'Ya está en tu pantalla de inicio.';
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPromptEvent = event;
  });

  button.onclick = async () => {
    if (!installPromptEvent) {
      showHelp();
      return;
    }
    installPromptEvent.prompt();
    const choice = await installPromptEvent.userChoice;
    installPromptEvent = null;
    if (choice.outcome === 'accepted') {
      button.textContent = 'Instalando…';
      help.textContent = 'Seguí los pasos que muestra el navegador.';
    } else {
      showHelp();
    }
  };

  window.addEventListener('appinstalled', () => {
    button.textContent = 'Librarium instalada';
    button.disabled = true;
    help.textContent = 'Ya está en tu pantalla de inicio.';
  });
}

export function setupServiceWorkerUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const notice = $('#updateNotice');
  const applyBtn = $('#applyUpdateBtn');
  const dismissBtn = $('#dismissUpdateBtn');
  if (!notice || !applyBtn || !dismissBtn) return;

  const show = () => notice.classList.remove('hidden');
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  let registrationRef: ServiceWorkerRegistration | null = null;
  const inspectedWorkers = new WeakSet<ServiceWorker>();

  const inspect = (registration: ServiceWorkerRegistration) => {
    if (registration.waiting && navigator.serviceWorker.controller) show();
    const worker = registration.installing;
    if (worker && !inspectedWorkers.has(worker)) {
      inspectedWorkers.add(worker);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) show();
      });
    }
  };

  const check = () => {
    if (!registrationRef || document.visibilityState !== 'visible') return;
    registrationRef.update().then(() => inspect(registrationRef!)).catch(() => {});
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  navigator.serviceWorker
    .register('./service-worker.js', { updateViaCache: 'none' })
    .then((registration) => {
      registrationRef = registration;
      registration.addEventListener('updatefound', () => inspect(registration));
      inspect(registration);
      check();
      setInterval(check, 5 * 60 * 1000);
      document.addEventListener('visibilitychange', check);
      window.addEventListener('pageshow', check);
      window.addEventListener('focus', check);
      window.addEventListener('online', check);
    })
    .catch(() => {});

  applyBtn.onclick = () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });
  };
  dismissBtn.onclick = () => notice.classList.add('hidden');
}

