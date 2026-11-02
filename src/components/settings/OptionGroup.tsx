/**
 * A labeled row of mutually exclusive option buttons, for settings with a few
 * short choices.
 */

"use client";

interface OptionButtonProps {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function OptionButton({ selected, onClick, children }: OptionButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`ui-text-sm rounded-md px-4 py-2 font-medium transition-colors ${
        selected
          ? "bg-primary-solid text-primary-solid-foreground"
          : "control-outline bg-surface-muted text-body hover:bg-fill-muted"
      }`}
    >
      {children}
    </button>
  );
}

interface OptionGroupProps<T extends string> {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

export function OptionGroup<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: OptionGroupProps<T>) {
  return (
    <div>
      <label className="ui-text-sm text-body block font-medium">{label}</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((option) => (
          <OptionButton
            key={option.value}
            selected={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </OptionButton>
        ))}
      </div>
      {description && <p className="ui-text-sm text-muted mt-1">{description}</p>}
    </div>
  );
}
