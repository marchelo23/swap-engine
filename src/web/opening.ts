import { get } from './ui.js';

const glyphs = [
  'M58 8 C49 0 16 -2 9 9 C-1 28 15 31 34 36 C53 41 65 45 60 61 C56 77 20 79 5 67',
  'M3 3 L15 74 L33 25 L51 74 L63 3',
  'M3 74 L32 3 L61 74 M15 48 H49',
  'M6 74 V3 H35 C68 3 68 41 35 41 H6',
  'M58 8 C49 0 16 -2 9 9 C-1 28 15 31 34 36 C53 41 65 45 60 61 C56 77 20 79 5 67',
];
const columns = 5;
const lines = 6;
const samples = 20;
const revealAt = 2800;
const total = 3230;
const lerp = (a: number, b: number, t: number) => a * (1 - t) + b * t;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };

function letterPoints() {
  return glyphs.map(shape => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', shape);
    const length = path.getTotalLength();
    // Split the A's independent crossbar into a separate segment.
    const split = shape.includes('M15 48') ? length - 34 : length;
    return Array.from({ length: lines }, (_, row) => {
      const crossbar = split < length && row === lines - 1;
      const segments = split < length ? lines - 1 : lines;
      return Array.from({ length: samples + 1 }, (_, step) => {
        const position = crossbar ? lerp(split + 0.001, length, step / samples) : (row + step / samples) / segments * split;
        return path.getPointAtLength(position);
      });
    });
  });
}

export function playOpening() {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  if (media.matches) return;
  const overlay = get('opening-overlay');
  const canvas = get<HTMLCanvasElement>('opening');
  const shell = get('workspace-shell');
  const skip = get('skip-intro');
  const context = canvas.getContext('2d');
  if (!context) return;
  const paint = context;
  const letters = letterPoints();
  let frame = 0;
  let start: number | undefined;
  let revealed = false;

  function enter() {
    if (revealed || media.matches) return;
    revealed = true;
    const units = ['.cube-send', '.cube-swap', '.cube-receive'];
    units.forEach((selector, index) => {
      document.querySelector(selector)?.animate([
        { translate: `${(index - 1) * 55}px 38px -175px`, rotate: `1 0 0 ${index === 1 ? -13 : 21}deg` },
        { translate: '0 0 0', rotate: '1 0 0 0deg' },
      ], { duration: 790, delay: (index === 1 ? 0 : index === 0 ? 75 : 150), easing: 'cubic-bezier(.17,.78,.24,1)', fill: 'backwards' });
    });
    document.querySelector('.stage-shadow')?.animate(
      [{ opacity: 0, scale: '.87 .6' }, { opacity: 1, scale: '1 1' }],
      { duration: 950, easing: 'ease-out' },
    );
  }

  function finish() {
    cancelAnimationFrame(frame);
    const restoreFocus = overlay.contains(document.activeElement);
    overlay.hidden = true;
    shell.inert = false;
    if (restoreFocus) get('main').focus({ preventScroll: true });
    media.removeEventListener('change', motionChanged);
    skip.removeEventListener('click', finish);
    window.removeEventListener('hashchange', finish);
    enter();
  }

  function motionChanged() {
    if (media.matches) finish();
  }

  function draw(now: number) {
    start ??= now;
    const time = now - start;
    if (time >= total) { finish(); return; }
    const ratio = Math.min(devicePixelRatio, 2);
    const viewWidth = overlay.clientWidth;
    const viewHeight = overlay.clientHeight;
    const width = Math.round(viewWidth * ratio);
    const height = Math.round(viewHeight * ratio);
    if (!width || !height) { finish(); return; }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    overlay.style.opacity = String(1 - ease((time - revealAt) / (total - revealAt)));
    if (time >= revealAt) enter();
    paint.setTransform(width / viewWidth, 0, 0, height / viewHeight, 0, 0);
    paint.clearRect(0, 0, viewWidth, viewHeight);
    const scale = Math.min(viewWidth / 620, viewHeight / 320, 1.65);
    const left = viewWidth * .075;
    const length = viewWidth - left * 2;
    paint.save();
    if (time < 360) {
      paint.beginPath();
      paint.rect(0, 0, left + (length + 2) * ease(time / 360), viewHeight);
      paint.clip();
    }
    const wave = ease((time - 420) / 500);
    const morph = ease((time - 1120) / 1000);
    paint.globalAlpha = ease(time / 240) * (1 - ease((time - 2300) / 520));
    paint.strokeStyle = '#111';
    paint.lineCap = 'round';
    paint.lineJoin = 'round';
    paint.lineWidth = 1.5;
    for (let row = 0; row < lines; row++) {
      paint.beginPath();
      for (let column = 0; column < columns; column++) {
        for (let segment = 0; segment <= samples; segment++) {
          const u = (column + segment / samples) / columns;
          const sourceX = left + u * length;
          const sourceY = viewHeight / 2 + scale * ((row - 2.5) * 17 + wave * (
            17 * Math.sin(u * 13 - time * 0.006 + row * 0.56) +
            5 * Math.cos(u * 19 - time * 0.004 + row * 0.22)
          ));
          const target = letters[column]![row]![segment]!;
          const x = lerp(sourceX, viewWidth / 2 + scale * (column * 77 + target.x - 185), morph);
          const y = lerp(sourceY, viewHeight / 2 + scale * (target.y - 37), morph);
          if (segment === 0 && (column === 0 || morph > 0)) paint.moveTo(x, y);
          else paint.lineTo(x, y);
        }
      }
      paint.stroke();
    }
    paint.restore();
    frame = requestAnimationFrame(draw);
  }

  overlay.hidden = false;
  shell.inert = true;
  media.addEventListener('change', motionChanged);
  skip.addEventListener('click', finish, { once: true });
  window.addEventListener('hashchange', finish, { once: true });
  frame = requestAnimationFrame(draw);
}
