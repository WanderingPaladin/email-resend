import { BATCH_SIZE_CHOICES, MAX_BATCH_SIZE, MIN_BATCH_SIZE } from '@shared/constants';
import { Input, Select } from '@/components/ui/form';

/** Number of emails a campaign sends at most: pick a common size or type any number. */
export function BatchSizeInput({
  value,
  onChange,
  disabled,
}: {
  value: number | string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const current = Number(value);
  const isChoice = (BATCH_SIZE_CHOICES as readonly number[]).includes(current);
  return (
    <div className="flex gap-2">
      <Select
        aria-label="Batch size"
        className="w-32 shrink-0"
        value={isChoice ? String(current) : 'custom'}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value !== 'custom') onChange(e.target.value);
        }}
      >
        {BATCH_SIZE_CHOICES.map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString()}
          </option>
        ))}
        <option value="custom">Other…</option>
      </Select>
      <Input
        type="number"
        aria-label="Batch size number"
        min={MIN_BATCH_SIZE}
        max={MAX_BATCH_SIZE}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
