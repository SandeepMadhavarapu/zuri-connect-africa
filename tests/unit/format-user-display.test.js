/**
 * Unit tests for the shared user-display formatter used on Account/Profile,
 * Home greeting, and any other surface that shows the signed-in user's
 * name or phone.
 *
 * These helpers are display-only — they MUST be tolerant of missing/invalid
 * input and MUST NOT throw. They MUST also be idempotent so re-rendering
 * with already-formatted values keeps the same output.
 */

import { describe, expect, it } from 'vitest';
import {
  formatKenyanPhone,
  formatDisplayName,
  getFirstNameForGreeting,
  getAvatarInitials,
  PHONE_NOT_LINKED_FALLBACK,
  DISPLAY_NAME_FALLBACK,
  GREETING_NAME_FALLBACK,
} from '@/lib/formatters/userDisplay';

describe('formatKenyanPhone', () => {
  it.each([
    ['254712345678',      '+254 712 345 678'],
    ['+254712345678',     '+254 712 345 678'],
    ['0712345678',        '+254 712 345 678'],
    ['712345678',         '+254 712 345 678'],
    ['+254 712 345 678',  '+254 712 345 678'],   // already-formatted is idempotent
    ['254 712 345 678',   '+254 712 345 678'],
    ['0712 345 678',      '+254 712 345 678'],
  ])('formats Kenyan mobile %s → %s', (input, expected) => {
    expect(formatKenyanPhone(input)).toBe(expected);
  });

  it('formats newer 1XX-prefix mobile numbers', () => {
    expect(formatKenyanPhone('+254110123456')).toBe('+254 110 123 456');
    expect(formatKenyanPhone('0110123456')).toBe('+254 110 123 456');
  });

  it('returns "Phone not linked" for null, undefined, empty, and whitespace', () => {
    expect(formatKenyanPhone(null)).toBe(PHONE_NOT_LINKED_FALLBACK);
    expect(formatKenyanPhone(undefined)).toBe(PHONE_NOT_LINKED_FALLBACK);
    expect(formatKenyanPhone('')).toBe(PHONE_NOT_LINKED_FALLBACK);
    expect(formatKenyanPhone('   ')).toBe(PHONE_NOT_LINKED_FALLBACK);
  });

  it('preserves non-Kenyan numbers without crashing', () => {
    expect(formatKenyanPhone('+1 555 0100')).toBe('+1 555 0100');
    expect(formatKenyanPhone('+44 7700 900000')).toBe('+44 7700 900000');
  });

  it('preserves unparseable strings without crashing', () => {
    expect(formatKenyanPhone('not-a-number')).toBe('not-a-number');
    expect(formatKenyanPhone(123456)).toBe('123456'); // numeric input coerced
  });
});

describe('formatDisplayName', () => {
  it.each([
    ['madhavarapu sandeep', 'Madhavarapu Sandeep'],
    ['MARY-JANE WATSON',    'Mary-Jane Watson'],
    ['john  smith',         'John Smith'],          // collapses doubled spaces
    ['o\'connor',           'O\'Connor'],
    ['ANN',                 'Ann'],
    ['a',                   'A'],
  ])('title-cases %s → %s', (input, expected) => {
    expect(formatDisplayName(input)).toBe(expected);
  });

  it('preserves already mixed-case names (McDonald, DeLong)', () => {
    expect(formatDisplayName('McDonald')).toBe('McDonald');
    expect(formatDisplayName('DeLong')).toBe('DeLong');
    expect(formatDisplayName('LeBron James')).toBe('LeBron James');
  });

  it('passes through email and phone strings untouched', () => {
    expect(formatDisplayName('user@example.com')).toBe('user@example.com');
    expect(formatDisplayName('+254712345678')).toBe('+254712345678');
    expect(formatDisplayName('254712345678')).toBe('254712345678');
  });

  it('falls back safely for missing or empty input', () => {
    expect(formatDisplayName(null)).toBe(DISPLAY_NAME_FALLBACK);
    expect(formatDisplayName(undefined)).toBe(DISPLAY_NAME_FALLBACK);
    expect(formatDisplayName('')).toBe(DISPLAY_NAME_FALLBACK);
    expect(formatDisplayName('   ')).toBe(DISPLAY_NAME_FALLBACK);
  });
});

describe('getFirstNameForGreeting', () => {
  it('returns the title-cased first token of a full name', () => {
    expect(getFirstNameForGreeting('madhavarapu sandeep')).toBe('Madhavarapu');
    expect(getFirstNameForGreeting('JOHN SMITH')).toBe('John');
  });

  it('uses the email local-part when only an email is available', () => {
    expect(getFirstNameForGreeting('jane.doe@example.com')).toBe('Jane');
    expect(getFirstNameForGreeting('alex@example.com')).toBe('Alex');
  });

  it('falls back to "there" for missing or unusable input', () => {
    expect(getFirstNameForGreeting(null)).toBe(GREETING_NAME_FALLBACK);
    expect(getFirstNameForGreeting(undefined)).toBe(GREETING_NAME_FALLBACK);
    expect(getFirstNameForGreeting('')).toBe(GREETING_NAME_FALLBACK);
    expect(getFirstNameForGreeting('+254712345678')).toBe(GREETING_NAME_FALLBACK);
  });
});

describe('getAvatarInitials', () => {
  it('returns up to two uppercase initials', () => {
    expect(getAvatarInitials('madhavarapu sandeep')).toBe('MS');
    expect(getAvatarInitials('Mary-Jane Watson')).toBe('MW');
    expect(getAvatarInitials('Ann')).toBe('A');
  });

  it('derives initials from email when no name available', () => {
    expect(getAvatarInitials('jane.doe@example.com')).toBe('JD');
    expect(getAvatarInitials('alex@example.com')).toBe('A');
  });

  it('returns the fallback when input is missing', () => {
    expect(getAvatarInitials(null)).toBe('U');
    expect(getAvatarInitials('')).toBe('U');
    expect(getAvatarInitials(undefined, 'Z')).toBe('Z');
  });
});
