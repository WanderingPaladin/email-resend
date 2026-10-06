import { describe, expect, it } from 'vitest';
import { createMemorySettingsRepository } from '../electron/repositories/settings.repository';
import { TemplateStore } from '../electron/services/template-store.service';
import { templateSaveInputSchema } from '../shared/schemas';

describe('saved email templates', () => {
  const store = () => {
    let n = 0;
    return new TemplateStore(createMemorySettingsRepository(), () => `t${++n}`, () => new Date('2026-10-06T12:00:00Z'));
  };

  it('creates, lists by name, updates and deletes templates', () => {
    const templates = store();
    const intro = templates.save({ name: 'Intro', subject: 'Hi {{first_name}}', body: '<p>Hello</p>', bodyFormat: 'html' });
    templates.save({ name: 'follow-up', subject: 'Following up', body: 'Hi again', bodyFormat: 'text' });
    expect(templates.list().map((t) => t.name)).toEqual(['follow-up', 'Intro']);

    const updated = templates.save({ id: intro.id, name: 'Intro', subject: 'Hello {{first_name}}', body: '<p>Hi</p>', bodyFormat: 'html' });
    expect(updated.id).toBe(intro.id);
    expect(templates.list().find((t) => t.id === intro.id)?.subject).toBe('Hello {{first_name}}');

    templates.delete(intro.id);
    expect(templates.list().map((t) => t.name)).toEqual(['follow-up']);
  });

  it('refuses a second template with the same name', () => {
    const templates = store();
    templates.save({ name: 'Intro', subject: 'a', body: 'b', bodyFormat: 'text' });
    expect(() => templates.save({ name: ' intro ', subject: 'c', body: 'd', bodyFormat: 'text' })).toThrow('already exists');
    expect(() => templates.save({ id: 'missing', name: 'Other', subject: 'c', body: 'd', bodyFormat: 'text' })).toThrow('no longer exists');
  });

  it('requires a name', () => {
    expect(templateSaveInputSchema.safeParse({ name: '  ', subject: '', body: '', bodyFormat: 'text' }).success).toBe(false);
  });
});
