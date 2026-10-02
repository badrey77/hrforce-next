import { describe, expect, it } from 'vitest';
import { algiersDate, freshLoginRequired, parseMaxAge, parseUiLocales, uriIssue, uriListIssues } from './rules.js';

describe('uriIssue (assumption 9: exact https URIs, http only on loopback)', () => {
  it('accepts https anywhere and http on loopback hosts with any port', () => {
    for (const ok of [
      'https://app.example.dz/callback',
      'https://app.example.dz:8443/cb?x=1',
      'http://localhost:4300/callback',
      'http://127.0.0.1/cb',
      'http://[::1]:9000/cb',
      'http://localhost:4300/',
    ]) {
      expect(uriIssue(ok), ok).toBeNull();
    }
  });

  it('refuses plain http on other hosts', () => {
    expect(uriIssue('http://app.example.dz/cb')).toBe('insecure_uri');
    expect(uriIssue('http://10.0.0.5/cb')).toBe('insecure_uri');
    expect(uriIssue('http://localhost.evil.example/cb')).toBe('insecure_uri');
  });

  it('refuses fragments, user-info, wildcards, other schemes, relative and over-long URIs', () => {
    for (const bad of [
      'https://app.example.dz/cb#x',
      'https://user@app.example.dz/cb',
      'https://user:pw@app.example.dz/cb',
      'https://@app.example.dz/cb',
      'https://*.example.dz/cb',
      'https://app.example.dz/*',
      'ftp://app.example.dz/cb',
      'javascript:alert(1)',
      '/callback',
      'app.example.dz/cb',
      'https:///cb',
      `https://app.example.dz/${'a'.repeat(2000)}`,
      'https://app.example.dz/c b',
      '',
    ]) {
      expect(uriIssue(bad), bad).toBe('invalid_uri');
    }
  });

  it('lists: required, too_many, per-item codes and duplicates', () => {
    expect(uriListIssues('redirectUris', [], { required: true })).toEqual([expect.objectContaining({ field: 'redirectUris', code: 'required' })]);
    expect(uriListIssues('postLogoutRedirectUris', [], { required: false })).toEqual([]);
    const eleven = Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`);
    expect(uriListIssues('redirectUris', eleven, { required: true }).map((i) => i.code)).toEqual(['too_many']);
    expect(
      uriListIssues('redirectUris', ['https://a.example/cb', 'http://a.example/cb', 'https://a.example/cb', 42], { required: true }).map((i) => [i.field, i.code]),
    ).toEqual([
      ['redirectUris.1', 'insecure_uri'],
      ['redirectUris.2', 'duplicate'],
      ['redirectUris.3', 'invalid_uri'],
    ]);
  });
});

describe('freshLoginRequired (complete, step 5)', () => {
  const now = new Date('2026-09-30T10:00:00Z');
  const created = Math.floor(new Date('2026-09-30T09:59:30Z').getTime() / 1000);
  it('prompt=login needs a login after the interaction was created', () => {
    expect(freshLoginRequired({ prompt: 'login', maxAge: undefined, authTime: new Date('2026-09-30T09:00:00Z'), interactionCreatedAt: created, now })).toBe(true);
    expect(freshLoginRequired({ prompt: 'consent login', maxAge: undefined, authTime: new Date('2026-09-30T09:59:45Z'), interactionCreatedAt: created, now })).toBe(false);
    expect(freshLoginRequired({ prompt: undefined, maxAge: undefined, authTime: new Date('2026-09-30T09:00:00Z'), interactionCreatedAt: created, now })).toBe(false);
  });

  it('max_age: a login older than max_age seconds', () => {
    expect(freshLoginRequired({ prompt: undefined, maxAge: 60, authTime: new Date('2026-09-30T09:58:00Z'), interactionCreatedAt: created, now })).toBe(true);
    expect(freshLoginRequired({ prompt: undefined, maxAge: 60, authTime: new Date('2026-09-30T09:59:30Z'), interactionCreatedAt: created, now })).toBe(false);
    expect(freshLoginRequired({ prompt: undefined, maxAge: 0, authTime: new Date('2026-09-30T09:59:59Z'), interactionCreatedAt: created, now })).toBe(true);
  });

  it('parseUiLocales keeps the languages HRForce speaks, in order, without duplicates', () => {
    expect(parseUiLocales('ar-DZ fr')).toEqual(['ar', 'fr']);
    expect(parseUiLocales('de AR en-GB ar')).toEqual(['ar', 'en']);
    expect(parseUiLocales('de es')).toEqual([]);
    expect(parseUiLocales(undefined)).toEqual([]);
    expect(parseUiLocales(['ar'])).toEqual([]);
    expect(parseUiLocales('ar '.repeat(100))).toEqual([]);
  });

  it('parseMaxAge accepts non-negative integers as number or string', () => {
    expect(parseMaxAge('60')).toBe(60);
    expect(parseMaxAge(0)).toBe(0);
    expect(parseMaxAge('-1')).toBeUndefined();
    expect(parseMaxAge('1.5')).toBeUndefined();
    expect(parseMaxAge(undefined)).toBeUndefined();
  });
});

describe('algiersDate', () => {
  it('is the calendar date in Africa/Algiers (UTC+1)', () => {
    expect(algiersDate(Date.parse('2026-09-30T23:30:00Z'))).toBe('2026-10-01');
    expect(algiersDate(Date.parse('2026-09-30T22:59:00Z'))).toBe('2026-09-30');
  });
});
