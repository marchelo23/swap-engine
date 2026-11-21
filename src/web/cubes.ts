import { defaultPair, linkRail, railLabel, rails, stepRail, type Pair, type Rail, type Side, type Turn } from './rails.js';
import { get } from './ui.js';

const sides = ['send', 'receive'] as const;
const dragThreshold = 34;
const clamp = (n: number) => Math.max(-32, Math.min(32, n));

function makeCube(side: Side, motion: MediaQueryList, stacked: MediaQueryList) {
  const root = get(side + '-cube');
  const selector = get<HTMLSelectElement>(side + '-network');
  const grip = get<HTMLButtonElement>(side + '-grip');
  const rotor = root.querySelector<HTMLElement>('.cube-rotor')!;
  const top = root.querySelector<HTMLElement>('.plane-top .turn-label')!;
  const bottom = root.querySelector<HTMLElement>('.plane-bottom .turn-label')!;
  const left = root.querySelector<HTMLElement>('.plane-left .turn-label')!;
  const right = root.querySelector<HTMLElement>('.plane-right .turn-label')!;
  const faces = [top, bottom, left, right];
  const railUse = root.querySelector<SVGUseElement>('.rail-icon use')!;
  let rail = defaultPair[side];
  let preview = 0;
  let running: Animation | undefined;

  function angle(degrees: number, lift = 0) {
    return stacked.matches ? `rotateY(${degrees}deg)` : `translateY(${lift}px) rotateX(${degrees}deg)`;
  }

  function clearFaces(except?: HTMLElement) {
    for (const face of faces) {
      if (face === except || face.dataset.rail === undefined) continue;
      face.textContent = '';
      delete face.dataset.rail;
    }
  }

  function show(incoming: Rail, direction: Turn) {
    const [forward, backward] = stacked.matches ? [left, right] : [bottom, top];
    const face = direction === 1 ? forward : backward;
    if (face.dataset.rail !== incoming) {
      const icon = railUse.parentElement!.cloneNode(true) as SVGSVGElement;
      const use = icon.querySelector('use')!;
      use.removeAttribute('id');
      use.setAttribute('href', '#icon-' + incoming);
      face.replaceChildren(icon, railLabel[incoming].toUpperCase());
      face.dataset.rail = incoming;
    }
    clearFaces(face);
  }

  function render() {
    selector.value = rail;
    root.dataset.rail = rail;
    railUse.setAttribute('href', '#icon-' + rail);
    clearFaces();
  }
  render();

  function drag(delta: number) {
    if (running || motion.matches) return;
    preview = clamp(delta * .36);
    const direction = delta < 0 ? -1 : 1;
    show(stepRail(rail, direction), direction);
    rotor.style.transform = angle(preview);
  }

  async function snap(next?: Rail, direction: Turn = 1) {
    running?.cancel();
    if (next) show(next, direction);
    if (!motion.matches) {
      const animation = rotor.animate([
        { transform: angle(preview) },
        ...(next ? [{ transform: angle(direction * 63, direction * 7), offset: .59 }] : []),
        { transform: angle(next ? direction * 90 : 0) },
      ], { duration: next ? 375 - Math.abs(preview) * 2 : 200, easing: 'cubic-bezier(.24,.68,.28,1)', fill: 'forwards' });
      running = animation;
      await animation.finished.catch(() => {});
      if (running !== animation) return;
      running = undefined;
      animation.cancel();
    }
    rotor.style.transform = '';
    preview = 0;
    if (next) rail = next;
    render();
  }

  motion.addEventListener('change', event => { if (event.matches) running?.finish(); });
  stacked.addEventListener('change', () => {
    running?.finish();
    rotor.style.transform = '';
    preview = 0;
    clearFaces();
  });
  return { root, selector, grip, drag, snap, current: () => rail };
}

export function mountCubes(onChange: () => void, onSettle: (pair: Pair) => void) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const stacked = matchMedia('(max-width: 700px)');
  const cubes = { send: makeCube('send', motion, stacked), receive: makeCube('receive', motion, stacked) };
  const instructions = get('rotation-help');
  const desktopInstructions = instructions.textContent;
  function updateInstructions() {
    instructions.textContent = stacked.matches
      ? 'Swipe right for the next network or left for the previous network. You can also use the Right and Left arrow keys.'
      : desktopInstructions;
  }
  updateInstructions();
  stacked.addEventListener('change', updateInstructions);
  let target = { ...defaultPair };
  const directions: Record<Side, Turn> = { send: 1, receive: 1 };
  let aligning = false;

  async function align() {
    if (aligning) return;
    aligning = true;
    get('quote-form').dataset.turning = 'true';
    while (sides.some(side => cubes[side].current() !== target[side])) {
      await Promise.all(sides.map(side => {
        const cube = cubes[side];
        const direction = directions[side];
        if (cube.current() === target[side]) return;
        cube.root.dataset.rotating = '';
        return cube.snap(stepRail(cube.current(), direction), direction);
      }));
    }
    aligning = false;
    for (const side of sides) delete cubes[side].root.dataset.rotating;
    delete get('quote-form').dataset.turning;
    onSettle({ ...target });
  }

  function choose(side: Side, rail: Rail, direction: Turn) {
    if (target[side] === rail) return false;
    const next = linkRail(target, side, rail);
    const other = side === 'send' ? 'receive' : 'send';
    directions[side] = direction;
    if (next[other] !== target[other]) directions[other] = 1;
    target = next;
    onChange();
    void align();
    return true;
  }

  for (const side of sides) {
    const cube = cubes[side];
    cube.selector.addEventListener('change', () => {
      const selected = cube.selector.value as Rail;
      cube.selector.value = cube.current();
      if (rails.includes(selected)) choose(side, selected, 1);
    });
    cube.grip.addEventListener('keydown', event => {
      const [forward, backward] = stacked.matches ? ['ArrowRight', 'ArrowLeft'] : ['ArrowDown', 'ArrowUp'];
      if (event.key !== forward && event.key !== backward) return;
      event.preventDefault();
      const direction = event.key === forward ? 1 : -1;
      choose(side, stepRail(target[side], direction), direction);
    });
    cube.grip.addEventListener('click', event => {
      if (event.detail === 0) choose(side, stepRail(target[side], 1), 1);
    });
    let wheelDelta = 0;
    let wheelLatched = false;
    let wheelIdle: number | undefined;
    cube.root.addEventListener('wheel', event => {
      if (stacked.matches || event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)
          || (event.target as Element).closest('input, select')) return;
      event.preventDefault();
      window.clearTimeout(wheelIdle);
      wheelIdle = window.setTimeout(() => { wheelLatched = false; wheelDelta = 0; }, 160);
      if (wheelLatched) return;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? cube.root.clientHeight : 1;
      wheelDelta += event.deltaY * unit;
      if (Math.abs(wheelDelta) < 36) return;
      wheelLatched = true;
      const direction = wheelDelta > 0 ? 1 : -1;
      choose(side, stepRail(target[side], direction), direction);
    }, { passive: false });
    let gesture: { id: number; start: number; grip: boolean; horizontal: boolean } | undefined;
    const position = (event: PointerEvent, horizontal: boolean) => horizontal ? event.clientX : event.clientY;
    stacked.addEventListener('change', () => { gesture = undefined; });
    cube.root.addEventListener('pointerdown', event => {
      const element = event.target as Element;
      if (!event.isPrimary || event.button !== 0 || element.closest('select, input, label, button:not(.rail-grip)')) return;
      const horizontal = stacked.matches;
      if (!horizontal && event.pointerType === 'touch' && !element.closest('.face-header, .rail-grip')) return;
      gesture = { id: event.pointerId, start: position(event, horizontal), grip: !!element.closest('.rail-grip'), horizontal };
      cube.root.setPointerCapture(event.pointerId);
    });
    cube.root.addEventListener('pointermove', event => {
      if (gesture?.id === event.pointerId && !aligning) cube.drag(position(event, gesture.horizontal) - gesture.start);
    });
    function end(event: PointerEvent, cancelled: boolean) {
      if (gesture?.id !== event.pointerId) return;
      const delta = position(event, gesture.horizontal) - gesture.start;
      const tap = gesture.grip && Math.abs(delta) < 4;
      gesture = undefined;
      const direction = !tap && delta < 0 ? -1 : 1;
      if (!cancelled && (tap || Math.abs(delta) >= dragThreshold)) {
        choose(side, stepRail(target[side], direction), direction);
      } else if (!aligning) {
        void cube.snap();
      }
    }
    cube.root.addEventListener('pointerup', event => end(event, false));
    cube.root.addEventListener('pointercancel', event => end(event, true));
    cube.root.addEventListener('lostpointercapture', event => end(event, true));
  }
}
