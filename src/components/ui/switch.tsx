/**
 * Switch Component
 *
 * An on/off toggle (`role="switch"`) for settings, in the usual label +
 * description + switch row.
 */

import type { ReactNode } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  /** Id of the element whose text labels the switch. */
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
}

/**
 * The visible switch is 24px tall; its hit area extends to the 44px touch-target
 * minimum (the pseudo-element is offset from the 20px padding box, inside the border).
 */
function Switch({ checked, onChange, labelledBy, describedBy, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out before:absolute before:-inset-3 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary-solid" : "bg-fill-muted"
      }`}
    >
      <span
        aria-hidden="true"
        className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

interface SwitchRowProps {
  /** Id for the label, which names the switch. */
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export function SwitchRow({ id, label, description, checked, onChange, disabled }: SwitchRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p id={id} className="ui-text-sm text-body font-medium">
          {label}
        </p>
        {description && (
          <p id={`${id}-description`} className="ui-text-sm text-muted mt-0.5">
            {description}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        labelledBy={id}
        describedBy={description ? `${id}-description` : undefined}
        disabled={disabled}
      />
    </div>
  );
}
