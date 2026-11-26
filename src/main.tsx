import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__deferredInstallPrompt = e as unknown as Window['__deferredInstallPrompt'];
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      window.setInterval(() => {
        void registration.update();
      }, 60 * 60 * 1000);
    }
  },
});

createRoot(document.getElementById('root')!).render(<App />);
