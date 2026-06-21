const fs = require('fs');
const path = require('path');

const migrationPath = path.resolve(
  __dirname,
  '../migrations/005_add_auth_and_push_fields.sql'
);

describe('005_add_auth_and_push_fields migration', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(migrationPath, 'utf8');
  });

  test('enforces UNIQUE(provider, subject) on auth_identities', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+auth_identities/i);
    expect(sql).toMatch(/UNIQUE\s*\(\s*provider\s*,\s*subject\s*\)/i);
  });

  test('requires sms_login_codes.expires_at to be NOT NULL', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+sms_login_codes/i);
    expect(sql).toMatch(/expires_at\s+TIMESTAMPTZ\s+NOT\s+NULL/i);
  });

  test('sets push_tokens.provider default to expo', () => {
    expect(sql).toMatch(/ALTER TABLE\s+push_tokens/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+provider\s+TEXT\s+DEFAULT\s+'expo'/i
    );
  });
});
