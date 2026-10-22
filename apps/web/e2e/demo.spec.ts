import { expect, test } from '@playwright/test';

const FOLLOW_UP = `Sam (Developer): Okay, then undoing an approval should also revoke their portal access.
Priya (PO): Yes, exactly.`;

test('seeded demo: suspected false alignment → private checks → confirmed difference → resolution → summary', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start-demo').click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f-]+\?sample=demo-undo-approval/);

  // Replay the meeting at maximum speed.
  await page.locator('input[type=range]').fill('20');
  await page.getByTestId('replay-play').click();
  await expect(page.getByTestId('replay-progress')).toHaveText('4/4 segments', { timeout: 20_000 });

  // Exactly one quiet suggestion: suspected, not claimed, disagreement.
  const card = page.getByTestId('suggestion');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Possible false alignment');
  await expect(card).toContainText('Suggested');
  await expect(card).toContainText('src/applications/approve.ts:22');
  await expect(card).toContainText('Can the applicant still use that access?');

  // Independent private answers.
  await page.getByTestId('check-Priya').getByRole('button', { name: 'No' }).click();
  await expect(card).toContainText('Suggested');
  await page.getByTestId('check-Sam').getByRole('button', { name: 'Yes' }).click();
  await expect(card).toContainText('Different expectations confirmed');
  await expect(page.getByTestId('suggested-question')).toContainText("should the applicant's access also be revoked?");

  // The team settles it in conversation.
  await page.getByTestId('replay-text').fill(FOLLOW_UP);
  await page.getByTestId('replay-play').click();
  await expect(page.getByText('Decided: Undoing the approval also revokes the access')).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('end-session').click();
  await expect(page).toHaveURL(/\/summary$/);
  await expect(page.getByTestId('agreed')).toContainText('confirmed through clarification');
  await expect(page.getByTestId('summary-markdown')).toHaveValue(/does not guarantee/);
});
