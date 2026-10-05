import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPublicEmails, isOutreachEmail } from './email-filter';

test('rejects malformed and placeholder addresses', () => {
  for (const email of [
    '%20info@sample-gym.com.au',
    "value='info@sample-dental.com",
    'example@email.com',
    'user@domain.com',
    'test@domain.com',
  ]) {
    assert.equal(isOutreachEmail(email), false, email);
  }
});

test('does not extract addresses from arbitrary HTML attributes', () => {
  const html = `<input value="info@sample-dental.com" />`;
  assert.deepEqual(extractPublicEmails(html), []);
});

test('rejects encoded, visible, and placeholder examples', () => {
  const html = `
    <a href="mailto:%20info@sample-gym.com.au">Email</a>
    <p>%20info@sample-gym.com.au</p>
    <p>example@email.com user@domain.com test@domain.com</p>
  `;
  assert.deepEqual(extractPublicEmails(html), []);
});

test('keeps legitimate visible and mailto business addresses', () => {
  const html = `
    <p>Contact info@sample-clinic.com</p>
    <a href="mailto:appointments@sample-clinic.com?subject=Booking">Book</a>
  `;
  assert.deepEqual(extractPublicEmails(html).sort(), [
    'appointments@sample-clinic.com',
    'info@sample-clinic.com',
  ]);
});
