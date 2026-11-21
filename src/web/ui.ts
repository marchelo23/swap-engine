export const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const text = (id: string, value: string) => { get(id).textContent = value; };

const number = new Intl.NumberFormat('en-US');
export const sats = (value: number | bigint) => number.format(value) + ' sats';
export const integer = (value: number | null) => value === null ? '—' : number.format(value);
export const message = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError'
  ? 'The request timed out. Try again.'
  : error instanceof TypeError ? 'Could not connect to the backend. Try again.'
  : error instanceof Error ? error.message : 'Request failed. Try again.';

export function details(element: HTMLElement, rows: Array<[string, string]>) {
  element.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    return row;
  }));
}
