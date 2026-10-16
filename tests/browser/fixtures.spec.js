import { test, expect } from '@playwright/test';

test.describe('Fixture Site Navigation', () => {
  const baseUrl = 'http://localhost:8000';

  test.beforeAll(async ({ request }) => {
    // Verify fixture site is running
    const response = await request.get(`${baseUrl}/index.html`);
    expect(response.ok()).toBeTruthy();
  });

  test('should load the home page', async ({ page }) => {
    await page.goto(baseUrl);
    await expect(page.getByRole('heading', { name: 'Browser Fixture Site' })).toBeVisible();
  });

  test('should navigate to forms page', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Forms")');
    await expect(page.getByRole('heading', { name: 'Forms' })).toBeVisible();
  });

  test('should navigate to tabs page', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Tabs")');
    await expect(page.getByRole('heading', { name: 'Tabs' })).toBeVisible();
  });

  test('should navigate to frames page', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Frames")');
    await expect(page.getByRole('heading', { name: 'Nested Frames' })).toBeVisible();
  });

  test('should navigate to challenges page', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Challenges")');
    await expect(page.getByRole('heading', { name: 'Challenges' })).toBeVisible();
  });
});

test.describe('Fixture Site Forms', () => {
  const baseUrl = 'http://localhost:8000';

  test('should fill and submit simple form', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Forms")');
    
    await page.fill('#simple-input', 'test input');
    await page.click('button:has-text("Submit")');
    
    // Form submission triggers alert
  });

  test('should fill login form', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Forms")');
    
    await page.fill('#login-email', 'test@example.com');
    await page.fill('#login-password', 'password123');
    
    // Form submission triggers alert
  });

  test('should handle checkboxes', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Forms")');
    
    const checkbox1 = page.locator('#checkbox-1');
    const checkbox2 = page.locator('#checkbox-2');
    
    await checkbox1.check();
    expect(await checkbox1.isChecked()).toBe(true);
    
    await checkbox2.uncheck();
    expect(await checkbox2.isChecked()).toBe(false);
  });
});

test.describe('Fixture Site Tabs', () => {
  const baseUrl = 'http://localhost:8000';

  test('should switch between tabs', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Tabs")');
    
    // Initially tab1 is active
    expect(await page.locator('#tab1').isVisible()).toBe(true);
    expect(await page.locator('#tab2').isVisible()).toBe(false);
    
    // Switch to tab2
    await page.click('button:has-text("Tab 2")');
    await expect(page.locator('#tab2')).toBeVisible();
    expect(await page.locator('#tab1').isVisible()).toBe(false);
    
    // Switch to tab3
    await page.click('button:has-text("Tab 3")');
    await expect(page.locator('#tab3')).toBeVisible();
  });
});

test.describe('Fixture Site Frames', () => {
  const baseUrl = 'http://localhost:8000';

  test('should have nested iframes', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Frames")');
    
    // Check that iframes exist
    const frames = page.frames();
    expect(frames.length).toBe(3); // Main frame + 2 iframes
  });

  test('should interact with iframe content', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Frames")');
    
    // Wait for frames to load
    await page.waitForSelector('iframe');
    
    // Get the first iframe
    const frame1 = page.frames()[1];
    if (frame1) {
      await frame1.fill('#frame1-input', 'test from frame 1');
    }
  });
});

test.describe('Fixture Site Challenges', () => {
  const baseUrl = 'http://localhost:8000';

  test('should verify OTP', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Challenges")');
    
    await page.fill('#otp-input', '123456');
    await page.click('button:has-text("Verify OTP")');
    
    // OTP verification triggers alert
  });

  test('should trigger approval flow', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Challenges")');
    
    const approvalBtn = page.locator('#approval-btn');
    await approvalBtn.click();
    
    // Approval triggers alert after delay
  });

  test('should handle delayed action', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Challenges")');
    
    const result = page.locator('#delayed-result');
    await page.click('button:has-text("Trigger Delayed Action")');
    
    expect(await result.textContent()).toBe('Processing...');
    
    // Wait for completion
    await page.waitForTimeout(2500);
    expect(await result.textContent()).toBe('Done!');
  });

  test('should toggle conditional content', async ({ page }) => {
    await page.goto(baseUrl);
    await page.click('button:has-text("Challenges")');
    
    const content = page.locator('#conditional-content');
    expect(await content.isVisible()).toBe(false);
    
    await page.click('button:has-text("Toggle Content")');
    expect(await content.isVisible()).toBe(true);
    
    await page.click('button:has-text("Toggle Content")');
    expect(await content.isVisible()).toBe(false);
  });
});
