import { test, expect, Page } from '@playwright/test';

// Smoke-тесты сигнального flow. Медиа — фейковые устройства (см. playwright.config),
// поэтому getUserMedia проходит и P2P реально устанавливается на localhost.

// Дождаться, пока WebSocket реально открыт: sendSignaling молча дропает сообщения,
// пока сокет не в состоянии OPEN. Клиентские глобалы объявлены через `let`, поэтому
// доступны как bare-идентификаторы (не как свойства window).
async function waitForWs(page: Page) {
  await page.waitForFunction(() => typeof (socket as any) !== 'undefined' && (socket as any).readyState === 1);
}

test('создание комнаты выводит на экран звонка', async ({ page }) => {
  await page.goto('/');
  await waitForWs(page);
  await page.fill('#create-name', 'Alice');
  await page.fill('#create-room-name', 'Room1');
  await page.fill('#create-password', 'pw123456');
  await page.getByRole('button', { name: 'Создать и получить ссылку' }).click();

  await expect(page.locator('#call-screen')).toBeVisible();
  await expect(page.locator('#share-bar')).toBeVisible();
});

test('два участника соединяются через approve + сигналинг', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto('/');
  await waitForWs(a);
  await a.fill('#create-name', 'Alice');
  await a.fill('#create-room-name', 'Room2');
  await a.fill('#create-password', 'pw123456');
  await a.getByRole('button', { name: 'Создать и получить ссылку' }).click();
  await expect(a.locator('#call-screen')).toBeVisible();

  // Инвайт-ссылка из состояния страницы (bare-глобалы: currentRoomId + hash пароля)
  const inviteUrl = await a.evaluate(
    () => `${location.origin}/#${currentRoomId}:${currentRoomPasswordHash}`
  );

  await b.goto(inviteUrl);
  await waitForWs(b);
  await b.fill('#join-user-name', 'Bob');
  await b.getByRole('button', { name: 'Войти в комнату' }).click();

  await expect(a.locator('#knock-modal')).toBeVisible();
  await a.locator('#btn-approve').click();

  await expect(b.locator('#call-screen')).toBeVisible();
  await expect(a.locator('.video-container:not(.local)')).toHaveCount(1);
  await expect(b.locator('.video-container:not(.local)')).toHaveCount(1);

  await ctxA.close();
  await ctxB.close();
});

test('неверный код доступа не пускает в комнату', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto('/');
  await waitForWs(a);
  await a.fill('#create-name', 'Alice');
  await a.fill('#create-room-name', 'Room3');
  await a.fill('#create-password', 'correct-pass');
  await a.getByRole('button', { name: 'Создать и получить ссылку' }).click();
  await expect(a.locator('#call-screen')).toBeVisible();

  const roomId = await a.evaluate(() => currentRoomId);

  await b.goto('/');
  await waitForWs(b);
  await b.getByRole('button', { name: 'Войти по ID' }).click();
  await b.fill('#join-user-name', 'Mallory');
  await b.fill('#join-room-id', roomId as string);
  await b.fill('#join-password', 'wrong-pass');
  // Ждём и подтверждаем alert об ошибке детерминированно (без гонки с reload)
  const dlg = b.waitForEvent('dialog');
  await b.getByRole('button', { name: 'Войти в комнату' }).click();
  await (await dlg).accept();

  // На стороне A стук не появляется
  await expect(a.locator('#knock-modal')).toBeHidden();

  await ctxA.close();
  await ctxB.close();
});

test('выход участника сразу освобождает слот (регресс grace)', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await a.goto('/');
  await waitForWs(a);
  await a.fill('#create-name', 'Alice');
  await a.fill('#create-room-name', 'Room4');
  await a.fill('#create-password', 'pw123456'); // лимит по умолчанию = 2
  await a.getByRole('button', { name: 'Создать и получить ссылку' }).click();
  await expect(a.locator('#call-screen')).toBeVisible();
  const inviteUrl = await a.evaluate(() => `${location.origin}/#${currentRoomId}:${currentRoomPasswordHash}`);

  // B входит и одобряется -> комната заполнена 2/2
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto(inviteUrl);
  await waitForWs(b);
  await b.fill('#join-user-name', 'Bob');
  await b.getByRole('button', { name: 'Войти в комнату' }).click();
  await expect(a.locator('#knock-modal')).toBeVisible();
  await a.locator('#btn-approve').click();
  await expect(a.locator('.video-container:not(.local)')).toHaveCount(1);

  // B выходит кнопкой (confirm -> accept)
  b.on('dialog', d => d.accept());
  await b.locator('#btn-leave').click();

  // A видит уход B почти сразу (не через 20с grace)
  await expect(a.locator('.video-container:not(.local)')).toHaveCount(0, { timeout: 6000 });

  // C сразу входит в освободившийся слот — никакого "комната заполнена"
  const ctxC = await browser.newContext();
  const c = await ctxC.newPage();
  c.on('dialog', d => d.accept());
  await c.goto(inviteUrl);
  await waitForWs(c);
  await c.fill('#join-user-name', 'Carol');
  await c.getByRole('button', { name: 'Войти в комнату' }).click();
  await expect(a.locator('#knock-modal')).toBeVisible({ timeout: 6000 });
  await a.locator('#btn-approve').click();
  await expect(c.locator('#call-screen')).toBeVisible();

  await ctxA.close();
  await ctxB.close();
  await ctxC.close();
});

test('выключение камеры пира показывает заглушку вместо чёрного видео', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto('/');
  await waitForWs(a);
  await a.fill('#create-name', 'Alice');
  await a.fill('#create-room-name', 'Room5');
  await a.fill('#create-password', 'pw123456');
  await a.getByRole('button', { name: 'Создать и получить ссылку' }).click();
  await expect(a.locator('#call-screen')).toBeVisible();
  const inviteUrl = await a.evaluate(() => `${location.origin}/#${currentRoomId}:${currentRoomPasswordHash}`);

  await b.goto(inviteUrl);
  await waitForWs(b);
  await b.fill('#join-user-name', 'Bob');
  await b.getByRole('button', { name: 'Войти в комнату' }).click();
  await expect(a.locator('#knock-modal')).toBeVisible();
  await a.locator('#btn-approve').click();
  await expect(a.locator('.video-container:not(.local)')).toHaveCount(1);

  const peerVideo = a.locator('.video-container:not(.local) video');
  const peerPlaceholder = a.locator('.video-container:not(.local) .video-avatar-placeholder');

  // Камера B включена (fake media) -> видно видео, заглушка скрыта
  await expect(peerVideo).not.toHaveClass(/hidden/);

  // B выключает камеру -> у A появляется аватар-заглушка, видео прячется (не чёрный кадр)
  await b.locator('#btn-cam').click();
  await expect(peerPlaceholder).not.toHaveClass(/hidden/);
  await expect(peerVideo).toHaveClass(/hidden/);

  // Кнопка модерации видео пропадает (нечего выключать), кнопка микрофона остаётся
  await expect(a.locator('.video-container:not(.local) .mod-tools button[id^="mod-video-"]')).toHaveClass(/hidden/);
  await expect(a.locator('.video-container:not(.local) .mod-tools button[id^="mod-audio-"]')).not.toHaveClass(/hidden/);

  await ctxA.close();
  await ctxB.close();
});
