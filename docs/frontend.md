# Swap Engine frontend

## Run

From the Front-end worktree with Node.js 22 or newer:

```sh
npm ci
npm start
```

Open [localhost:3000](http://127.0.0.1:3000/). The default mode is simulation. The API creates real quote records on the local store. The alternative mode, regtest read-only, uses the existing backend configuration and node credentials outside the browser. For a separate local preview in PowerShell:

```powershell
$env:PORT = '4178'
$env:APP_MODE = 'simulation'
$env:DATA_DIR = Join-Path $env:TEMP ('swap-engine-preview-' + [guid]::NewGuid())
npm start
```

Open [localhost:4178](http://127.0.0.1:4178/). Run `npm run build:web` before starting the TypeScript server directly, including service-managed starts. The build generates the existing allowlisted `src/web/app.js`; the server also serves the checked-in HTML and CSS. The frontend needs no new static routes.

```sh
npm run build
npm test
npx playwright install chromium
npm run test:web
```

To use installed Edge from PowerShell, set `$env:WEB_TEST_BROWSER_CHANNEL = 'msedge'` before `npm run test:web`. The browser tests save screenshots in `dist/web-verification`. Set `$env:WEB_TEST_RECORD = '1'` to save a WebM of the full-screen opening, 3D entrance, manual drag and linked rotation. Browser recording requires Playwright's FFmpeg binary, which can be installed with `npx playwright install ffmpeg`.

Verified on Windows with Node.js 24 and Edge. The build succeeded, the Node suite passed 170 tests with 2 skips, and 8 browser tests passed. Browser coverage includes prepared swap review and idempotency, Account error and retry states, the Operations balance contract, gestures, quote expiry, stale responses, axe scans, reduced motion and responsive layouts.

## Cube controls

SEND holds the principal and source selector. SWAP holds the fee breakdown and confirmation action. RECEIVE holds the destination selector and estimated receipt. Change a network in its native selector or use the cube's rotation control. On desktop, drag or scroll vertically, or use Down and Up. On phones, the cubes stack vertically. Swipe the outer cubes right to advance or left to go back, or use the corresponding arrow keys. A tap on the rotation arrow moves forward.

The rotation cycle is On-chain → Lightning → Liquid → Ark → On-chain. A direct selector change takes forward quarter turns through each intermediate rail. If both selected rails coincide, the opposite cube rotates forward to the next non-Ark rail. Quotes wait for both outer cubes to settle. Existing quotes are discarded on rail and amount changes. Amount edits share a short debounce, and a stale response cannot update the face values.

Selecting Ark ↔ On-chain (boarding or cooperative offboarding) quotes the regtest route via `POST /v1/ark/quotes`; selecting Ark ↔ Lightning or Ark ↔ Liquid shows “Solo regtest · swaps no disponibles” and disables quoting and swapping. The Ark panel in administrator Operations reflects the regtest Ark ↔ On-chain scope.

**Arkade mark:** Ark Labs. The local `src/web/arkade-mark.svg` is the unmodified monochrome
`Logo/SVG/arkade-mark-ink.svg` from the [official brand kit](https://arkadeos.com/arkade-brand-kit.zip)
(Edition 1, November 2026). Its README permits using the logo to refer to Arkade, but not to suggest partnership or endorsement without a written agreement. The brand guidelines allow the standalone mark in compact controls, at least 16 px wide. The mark identifies the rail; it does not imply an active integration or endorsement.

## Product contracts

| Surface | Current behavior |
| --- | --- |
| Swap | `POST /v1/quotes` accepts integer `amountSats` from 10,000 to 1,000,000. Net receipt is principal minus estimated claim fee. Estimated user cost is invoice total minus net receipt. The provider funding reserve is omitted from user costs. Lightning routing fees are unknown. |
| Rails | Lightning → On-chain and Ark ↔ On-chain (regtest boarding and cooperative offboarding) are supported quote routes. The generic quote is preview-only. A controlled reverse swap requires an authenticated, server-prepared swap and explicit approval. On-chain → Lightning, Ark ↔ Lightning, and routes involving Liquid show an unavailable state. |
| Status and history | The frontend reads prepared swaps from the authenticated owner API. Missing or closed gateways show unavailable. |
| Account | Same-origin sign-in, session verification and logout. The form accepts credentials even if the session endpoint is unavailable. A missing login endpoint displays a retryable error. A verified session is required to open the account. The browser keeps the CSRF token in memory and uses it for logout. It expects the session expiry in epoch milliseconds. |
| Operations | The UI requires a verified ADMIN session before revealing the admin view. On a regtest read-only backend it can read preflight, including structured 503 reports. The balance panel reads the authenticated endpoint below and shows unavailable data explicitly. |
| Reporting | Admin transaction lists, actual and earned fees, HTLC counts, Alice's preflight status, and revenue remain unavailable. |

### Reverse swap UI integration

Lightning → On-chain on regtest uses the authenticated owner gateway when configured. The generic cube quote remains preview-only. The prepared review is separate and uses server-bound terms.

| UI step | Backend input needed |
| --- | --- |
| Availability | An explicit regtest execution capability and a verified session authorized for the route. Missing, disabled, or unknown capability keeps Start swap disabled. |
| Review | The server's current quote, its expiry, the exact wallet-approved destination, principal, service fee, estimated claim fee, invoice total, and expected on-chain receipt. Keep unknown routing fees visible. Any change to the route, amount, quote, or destination invalidates the review. |
| Submit | A user-initiated confirmation using the authenticated endpoint, required CSRF token, and one idempotency key per reviewed intent. If the result is uncertain, resolve it using the backend's supported lookup or same-key replay contract before issuing another intent. |
| Track | A server-owned swap ID and an authenticated status endpoint with enforced ownership. Present the returned invoice, funding, confirmation, claim, and settlement evidence independently. Show completion only when the backend confirms the terminal state. |
| Recover | The backend's categorized failure, expiry, refund, or manual-review state and any approved next action. Refresh owned status before offering an action that can change state. |

Integration needs exact schemas and routes for capability, destination and wallet ownership, quote expiry and fees, idempotent create or lookup, and status and recovery. The UI should use only the public data those contracts require. Forward swaps and Liquid remain unavailable.

#### Prepared-swap contract

The owned gateway lists server-prepared swaps with `GET /v1/swaps` and supplies the prepared quote and `claimDestination`. The controlled flow rejects the generic `POST /v1/quotes` with `USE_PREPARED_SWAP`. The frontend pauses editable quotes as soon as the authenticated capability reports that the controlled gateway is configured.

- Confirmation maps to `POST /v1/swaps/reverse` with `{preparedSwapId, expectedRevision}` and an `Idempotency-Key` only after explicit confirmation and a fresh backend authorization and revision check. The prepared quote expiry is historical. The server creates and validates a fresh quote when executing. The browser displays the approval deadline and relies on the server for eligibility.
- `GET /v1/swaps/:id` provides owned state, revision, and `allowedActions`. `202 RUNNING` stays pending and `202 RECONCILIATION_REQUIRED` opens status and recovery guidance. A revision conflict requires refreshing the prepared swap and reviewing changes. A successful operation response is followed by the owned status read.
- `POST /v1/swaps/:id/reconcile` uses the current `expectedRevision` and its own idempotency key. Display the returned evidence or recovery recommendation. Recommendations such as `FUND`, `CLAIM`, or `SETTLE` do not authorize additional browser actions.

The browser uses the existing HttpOnly session through same-origin requests and supplies the verified session's CSRF token for POSTs. It persists only the exact request and idempotency key, scoped to account and swap. A separate key is used for reconciliation. Browser verification intercepts mutations and does not execute real payments.

### Operations balances

The frontend expects a same-origin `GET /v1/operations/balances` protected by server-side ADMIN authorization. A successful snapshot has `network: "regtest"` and `capturedAt` as an ISO 8601 UTC string. It includes `core`, `provider`, and `alice`. All three include `confirmedSats` and `unconfirmedSats`. The two LND entries also include `localSats` and `remoteSats` for Lightning channels. Amounts are nonnegative safe integers in sats or `null`. A whole node may be `null` if unavailable. Non-success or malformed responses clear the snapshot and display unavailable. The client does not derive balances from other endpoints.

Operations shows four batteries for Bitcoin Core Provider on-chain, LND Provider Lightning, LND Alice Lightning, and LND Alice on-chain. The on-chain batteries compare only the two displayed confirmed balances. Each Lightning battery uses its own reported local plus remote capacity, with a dark local share and gray remote share. A known zero total is empty. If either Lightning side is missing, the total and battery are unavailable even when the other side is known. After one minute, the panel marks the snapshot historical and keeps its original values and timestamp visible until refresh.

The deployment baseline is `integration/reverse-swap-regtest` at `f9bac1a6cf34478109b680492008f39d00ab6e28`. Browser tests cover the baseline's missing auth routes and use intercepted responses for sign-in, role verification and logout. A separate same-origin test with the local `auth-rbac` implementation and a temporary account verified a rejected password, an ADMIN session, the HttpOnly and SameSite cookie properties, and CSRF-protected logout. The auth routes still need to land in the integration branch. The repo audit reports four inherited dependency advisories in bitcoinjs-lib, ecpair, valibot and Zod. Dependency remediation belongs to the backend integration work.

## Design and implementation references

The current direction uses white and black with architectural linework and six-sided CSS 3D cubes. A full-screen canvas draws six equal-weight strokes, applies rightward phase-shifted waves and interpolates to sampled letter outlines. The overlay fades into the cube entrance and clears after about 3.2 seconds. The keyboard-operable skip control opens the workspace immediately. Reduced motion opens at the working cubes and changes rails without animated turns. The composition, marks and glyph paths were authored for Swap Engine.

Visual review used typography hierarchy and grid alignment from independent showcases and Codrops' examples of interaction that respects reduced motion. Godly redirected to Recent Design, whose page could not be retrieved. [Awwwards](https://www.awwwards.com/) · [Godly](https://godly.website/) · [CSS Design Awards](https://www.cssdesignawards.com/) · [Hoverstat.es](https://www.hoverstat.es/) · [Siteinspire](https://www.siteinspire.com/) · [Codrops Creative Hub](https://tympanus.net/codrops/hub/) · [Codrops motion and accessibility](https://tympanus.net/codrops/2026/03/31/arnaud-roccas-portfolio-from-a-gsap-powered-motion-system-to-fluid-webgl/)

| Repository and inspected source | Technique and decision | License and maintenance |
| --- | --- | --- |
| [Boltz Web App](https://github.com/BoltzExchange/boltz-web-app), [SwapChecker.tsx](https://github.com/BoltzExchange/boltz-web-app/blob/main/src/components/SwapChecker.tsx) | SolidJS effects and teardown for per-swap subscriptions, plus distinct swap state. Keep state sourced from the backend and clear quote requests on input changes. No implication that the reference's accessibility was audited. | AGPL-3.0. No code, assets or layout reused. Latest GitHub push observed August 2026. |
| [Codrops Interlude](https://github.com/codrops/interlude), [controller](https://github.com/codrops/interlude/blob/main/src/lib/interlude/controller.ts), [media readiness](https://github.com/codrops/interlude/blob/main/src/lib/interlude/media.ts) | Astro lifecycle hooks coordinate GSAP transitions, while readiness logic limits image waits to the viewport. Keep our media finite and separate from navigation, rendering and form interaction. Three.js and Lenis were considered. | MIT. Preserve notices if code is redistributed. Latest observed push November 2026. |
| [Radix Primitives](https://github.com/radix-ui/primitives), [Dialog](https://github.com/radix-ui/primitives/blob/main/packages/react/dialog/src/dialog.tsx) | Focus scope, dismissable layer and trigger restoration are explicit React primitives. The native dialog covers modal focus and Escape on this stack and is tested by keyboard. | MIT. Preserve notices if code is redistributed. Latest observed push October 2026. |
| [visx](https://github.com/airbnb/visx), [Axis implementation](https://github.com/airbnb/visx/blob/master/packages/visx-axis/src/axis/Axis.tsx) | React SVG uses separate scale/tick generation and drawing with caller-provided formatting. This suits future authorized data with explicit units and a textual equivalent. No chart is drawn while reporting is unavailable. | MIT. Preserve notices if code is redistributed. Latest observed push June 2026. |
| [Lenis](https://github.com/darkroomengineering/lenis), [scroll core](https://github.com/darkroomengineering/lenis/blob/main/packages/core/src/lenis.ts) | Vanilla RAF animation, event hooks and prevent rules show the cost of managing scroll, nested areas and wheel input. The lab keeps native scrolling and animates only the hero. | MIT. Preserve notices if code is redistributed. Latest observed push November 2026. |

Registry comparison on 2026-11-18 found GSAP 3.15.1 with Flip and ScrollTrigger shipped as separate plugin imports under the GSAP standard license, Lenis 1.3.27, Motion 14.14.0 with React 18 or 19 integration, Three.js 0.187.0, and React Three Fiber 9.8.2 with React 19 and Three.js 0.156 or newer. Native CSS and Canvas meet the interaction and lifecycle requirements without a library. [GSAP Flip](https://gsap.com/docs/v3/Plugins/Flip/) · [GSAP ScrollTrigger](https://gsap.com/docs/v3/Plugins/ScrollTrigger/) · [Motion](https://www.npmjs.com/package/motion) · [Three.js](https://www.npmjs.com/package/three) · [React Three Fiber](https://www.npmjs.com/package/@react-three/fiber)

Manrope Variable and IBM Plex Mono are licensed under SIL OFL 1.1. The original license notices ship in the bundle with the Latin WOFF2 assets. No commercial typeface or third-party art is in the design. [Manrope OFL](https://github.com/google/fonts/blob/main/ofl/manrope/OFL.txt) · [IBM Plex Mono OFL](https://github.com/google/fonts/blob/main/ofl/ibmplexmono/OFL.txt)
