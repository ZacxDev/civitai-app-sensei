import { fireEvent, screen } from '@testing-library/react';

/**
 * DOM-ONLY TEST HELPERS.
 *
 * 🔴 A SEPARATE FILE FROM `test-helpers.tsx` ON PURPOSE. That one is imported by
 * FIVE `node`-project tests (`lib/sessions.test.ts`, `lib/mentions.test.ts`,
 * `lib/research.test.ts`, `lib/turn-records.test.ts`, `reconcile-turns.test.ts`),
 * which run with no DOM — a top-level `@testing-library/react` import there
 * would break every one of them. Anything that touches the DOM belongs here.
 */

/**
 * Reach a session row's Rename / Delete / Copy-id control.
 *
 * 🔴 WHY THIS EXISTS AS A HELPER RATHER THAN TWO LINES AT EACH CALL SITE. The ⋮
 * menu moved Rename and Delete one press in, and EIGHT places across three e2e
 * suites reached `delete-session-<id>` directly — every one of them a regression
 * guard for a real prior incident (clawgate #425/#427/#434 and the
 * delete-scope transcript clears). Open-coding the extra press at eight sites is
 * how seven of them end up right and one of them silently stops exercising the
 * path it was written for. One rule, one place.
 *
 * The ASSERTIONS at those sites are untouched by this change — only the reach is.
 */
export function openSessionRowMenu(sessionId: string): void {
  fireEvent.click(screen.getByTestId(`session-menu-${sessionId}`));
}

/** Open the row's ⋮ menu and press Delete. */
export function deleteSessionRow(sessionId: string): void {
  openSessionRowMenu(sessionId);
  fireEvent.click(screen.getByTestId(`delete-session-${sessionId}`));
}

/** Open the row's ⋮ menu and press Rename. */
export function renameSessionRow(sessionId: string): void {
  openSessionRowMenu(sessionId);
  fireEvent.click(screen.getByTestId(`rename-session-${sessionId}`));
}

/**
 * Delete the FIRST session row on screen, whatever its id.
 *
 * For the one call site that deliberately does not know the id — it asserts a
 * route (`deleteSession` moving `activeSessionId` without a switcher click)
 * rather than a particular conversation.
 */
export function deleteFirstSessionRow(): void {
  const trigger = screen.getAllByTestId(/^session-menu-/)[0];
  const sessionId = (trigger.getAttribute('data-testid') ?? '').replace('session-menu-', '');
  fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId(`delete-session-${sessionId}`));
}
