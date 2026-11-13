/** The password fields, strength bar and checks, used by the popup setup and by the Security page. */
import { STRENGTH_LABELS, checkPassword, passwordAccepted, passwordStrength } from './password';
import { h, svg } from './ui';

export function passwordForm(onChange: (ok: boolean) => void): { element: HTMLElement; value: () => string } {
  const first = h('input', { id: 'p1', type: 'password', autocomplete: 'new-password', testid: 'zt-password-new', autofocus: true });
  const second = h('input', { id: 'p2', type: 'password', autocomplete: 'new-password', testid: 'zt-password-again' });
  const segments = [h('i'), h('i'), h('i'), h('i')];
  const strength = h('span', { class: 'strength', testid: 'zt-password-strength' });
  const check = (key: string, label: string) => h('div', { class: 'ck no', testid: `zt-password-check-${key}`, 'data-ok': 'false' }, svg('check', 14, 3), h('span', {}, label));
  const checks = [check('length', 'At least 12 characters'), check('common', 'Not a common password'), check('match', 'Both entries match')];
  const update = (): void => {
    const value = first.value;
    const level = passwordStrength(value);
    const colour = level <= 1 ? '#B42318' : level === 2 ? '#8A4B00' : '#0F766E';
    segments.forEach((s, i) => (s.style.background = i < level ? colour : '#E6E4DE'));
    strength.textContent = STRENGTH_LABELS[level];
    strength.style.color = level <= 1 ? '#B42318' : level === 2 ? '#8A4B00' : '#0B4F49';
    const { longEnough, notCommon } = checkPassword(value);
    const match = value.length > 0 && value === second.value;
    [longEnough, notCommon, match].forEach((ok, i) => {
      checks[i]!.classList.toggle('no', !ok);
      checks[i]!.dataset.ok = String(ok);
    });
    onChange(passwordAccepted(value) && match);
  };
  first.addEventListener('input', update);
  second.addEventListener('input', update);
  const element = h(
    'div',
    { style: 'display:flex;flex-direction:column;gap:14px' },
    h('div', { class: 'f tall' }, h('label', { for: 'p1' }, 'Password'), first, h('div', { class: 'meter', 'aria-hidden': 'true' }, ...segments), strength),
    h('div', { class: 'f tall' }, h('label', { for: 'p2' }, 'Type it again'), second),
    h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, ...checks),
    h('div', { class: 'tip' }, 'Tip: 4 random words, such as river-candle-tiger-moss'),
  );
  update();
  return { element, value: () => first.value };
}
