import { randomUUID } from 'node:crypto';
import type { TemplateSaveInput } from '../../shared/schemas';
import type { EmailTemplate } from '../../shared/types';
import type { SettingsRepository } from '../repositories/settings.repository';

export const MAX_TEMPLATES = 200;

/** Named email templates, saved on this computer. */
export class TemplateStore {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly newId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** All templates, sorted by name. */
  list(): EmailTemplate[] {
    return [...(this.repo.get('templates') ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  /** Creates a template, or updates the one with `input.id`. Names must be unique (ignoring case). */
  save(input: TemplateSaveInput): EmailTemplate {
    const all = this.repo.get('templates') ?? [];
    const name = input.name.trim();
    const clash = all.find((t) => t.id !== input.id && t.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new Error(`A template named "${clash.name}" already exists. Choose another name or update that template.`);
    const updatedAt = this.now().toISOString();
    const content = { name, subject: input.subject, body: input.body, bodyFormat: input.bodyFormat, updatedAt };
    if (input.id) {
      const index = all.findIndex((t) => t.id === input.id);
      if (index < 0) throw new Error('That template no longer exists.');
      const updated = { ...all[index]!, ...content };
      this.repo.set('templates', all.map((t, i) => (i === index ? updated : t)));
      return updated;
    }
    if (all.length >= MAX_TEMPLATES) throw new Error(`You can keep up to ${MAX_TEMPLATES} templates. Delete one first.`);
    const created = { id: this.newId(), ...content };
    this.repo.set('templates', [...all, created]);
    return created;
  }

  delete(id: string): void {
    this.repo.set('templates', (this.repo.get('templates') ?? []).filter((t) => t.id !== id));
  }
}
