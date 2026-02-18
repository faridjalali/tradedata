/**
 * Site passcode lock — gates the application behind an 8-digit passcode.
 *
 * Flow:
 *  1. Check /api/auth/check — if a valid server session exists, unlock immediately.
 *  2. Otherwise show the overlay, accept digit input (keyboard + on-screen keypad).
 *  3. When 8 digits are entered, POST /api/auth/verify — on success the server
 *     sets a session cookie and we call onUnlock(); on failure shake + clear.
 */

const SITE_LOCK_LENGTH = 8;

async function checkServerSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/check');
    return res.ok;
  } catch {
    return false;
  }
}

async function verifyPasscodeOnServer(passcode: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function initializeSiteLock(onUnlock: () => void): Promise<void> {
  const overlay = document.getElementById('site-lock-overlay') as HTMLElement | null;
  if (!overlay) {
    onUnlock();
    return;
  }

  if (!overlay.dataset.doubleTapBound) {
    overlay.addEventListener('dblclick', (event) => {
      event.preventDefault();
    });
    overlay.dataset.doubleTapBound = '1';
  }

  const panel = overlay.querySelector('.site-lock-panel') as HTMLElement | null;
  const statusEl = document.getElementById('site-lock-status') as HTMLElement | null;
  const dotEls = Array.from(overlay.querySelectorAll('.site-lock-dot')) as HTMLElement[];
  const digitButtons = Array.from(overlay.querySelectorAll('[data-lock-digit]')) as HTMLButtonElement[];
  const actionButtons = Array.from(overlay.querySelectorAll('[data-lock-action]')) as HTMLButtonElement[];

  // If a valid session already exists, skip the overlay entirely.
  if (await checkServerSession()) {
    overlay.classList.add('hidden');
    document.body.classList.remove('site-locked');
    onUnlock();
    return;
  }

  document.body.classList.add('site-locked');
  overlay.classList.remove('hidden');

  let entered = '';
  let verifying = false;

  const updateDots = () => {
    for (let i = 0; i < dotEls.length; i++) {
      dotEls[i].classList.toggle('filled', i < entered.length);
    }
  };

  const setStatus = (message: string) => {
    if (statusEl) statusEl.textContent = message;
  };

  const clearEntry = () => {
    entered = '';
    updateDots();
  };

  const handleSuccess = () => {
    overlay.classList.add('hidden');
    document.body.classList.remove('site-locked');
    window.removeEventListener('keydown', onKeyDown, true);
    onUnlock();
  };

  const handleFailure = () => {
    setStatus('');
    clearEntry();
    if (panel) {
      panel.classList.remove('shake');
      // Force reflow so the animation restarts even on a second failure.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      panel.offsetWidth;
      panel.classList.add('shake');
    }
    window.setTimeout(() => {
      if (panel) panel.classList.remove('shake');
    }, 320);
  };

  const verifyIfComplete = async () => {
    if (entered.length < SITE_LOCK_LENGTH || verifying) return;
    verifying = true;
    const passcode = entered;
    const ok = await verifyPasscodeOnServer(passcode);
    verifying = false;
    if (ok) {
      handleSuccess();
    } else {
      handleFailure();
    }
  };

  const appendDigit = (digit: string) => {
    if (!/^[0-9]$/.test(digit)) return;
    if (entered.length >= SITE_LOCK_LENGTH) return;
    entered += digit;
    setStatus('');
    updateDots();
    void verifyIfComplete();
  };

  const backspace = () => {
    if (!entered.length) return;
    entered = entered.slice(0, -1);
    setStatus('');
    updateDots();
  };

  digitButtons.forEach((button) => {
    button.addEventListener('click', () => {
      appendDigit(String(button.dataset.lockDigit ?? ''));
    });
  });

  actionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const action = String(button.dataset.lockAction ?? '');
      if (action === 'clear') {
        clearEntry();
        setStatus('');
      } else if (action === 'back') {
        backspace();
      }
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (overlay.classList.contains('hidden')) return;
    const key = event.key;
    if (/^[0-9]$/.test(key)) {
      event.preventDefault();
      appendDigit(key);
    } else if (key === 'Backspace') {
      event.preventDefault();
      backspace();
    } else if (key === 'Escape') {
      event.preventDefault();
      clearEntry();
      setStatus('');
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  updateDots();
}
