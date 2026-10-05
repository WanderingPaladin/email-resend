import { useEffect, useState } from 'react';
import { OPENAI_MODEL_CHOICES, priceFor } from '@shared/usage';
import { Input, Select } from '@/components/ui/form';

const OTHER = '__other__';

function priceNote(model: string): string {
  const price = priceFor(model);
  return price ? ` ($${price.input} in / $${price.output} out per 1M tokens)` : '';
}

/** Picks the OpenAI model for Find Contacts: one of the known models, or any other name typed in. */
export function ModelSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const known = OPENAI_MODEL_CHOICES.some((m) => m.id === value);
  const [other, setOther] = useState(!known);
  const [typed, setTyped] = useState(known ? '' : value);
  useEffect(() => {
    const isKnown = OPENAI_MODEL_CHOICES.some((m) => m.id === value);
    if (!isKnown) {
      setOther(true);
      setTyped(value);
    }
  }, [value]);

  return (
    <div className={className}>
      <Select
        value={other ? OTHER : value}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            return;
          }
          setOther(false);
          onChange(e.target.value);
        }}
      >
        {OPENAI_MODEL_CHOICES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label + priceNote(m.id)}
          </option>
        ))}
        <option value={OTHER}>Other model…</option>
      </Select>
      {other && (
        <Input
          className="mt-2"
          value={typed}
          disabled={disabled}
          placeholder="OpenAI model name, e.g. gpt-6.1-sol-2026-08-01"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => typed.trim() && typed.trim() !== value && onChange(typed.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && typed.trim()) onChange(typed.trim());
          }}
        />
      )}
    </div>
  );
}
