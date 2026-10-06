import { useEffect, useRef, useState } from 'react';
import type { Settings } from '@shared/schemas';

export interface CampaignForm {
  fromName: string;
  fromEmail: string;
  subject: string;
  body: string;
  bodyFormat: 'text' | 'html';
  batchSize: number;
  concurrency: number;
  dryRun: boolean;
  testRecipient: string;
  /** Saved template the subject and body were loaded from ('' when none). */
  templateId: string;
}

const EMPTY: CampaignForm = {
  fromName: '',
  fromEmail: '',
  subject: '',
  body: '',
  bodyFormat: 'text',
  batchSize: 100,
  concurrency: 5,
  dryRun: true,
  testRecipient: '',
  templateId: '',
};

/** Campaign draft kept at the app root so it survives page changes. Seeded from saved defaults. */
export function useCampaignForm(settings: Settings | undefined) {
  const [form, setForm] = useState<CampaignForm>(EMPTY);
  const seeded = useRef(false);

  useEffect(() => {
    if (!settings || seeded.current) return;
    seeded.current = true;
    setForm((f) => ({
      ...f,
      fromName: settings.fromName,
      fromEmail: settings.fromEmail,
      subject: settings.lastSubject,
      body: settings.lastBody,
      bodyFormat: settings.bodyFormat,
      batchSize: settings.batchSize,
      concurrency: settings.concurrency,
    }));
  }, [settings]);

  const update = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  return { form, update };
}

export type CampaignFormHook = ReturnType<typeof useCampaignForm>;
