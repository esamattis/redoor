import { Tooltip } from "#ui/components/tooltip";

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
});

/** Largest unit first, so a timestamp reads as "in 3 months" rather than "in 90 days". */
const relativeTimeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 86_400],
    ["month", 30 * 86_400],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
];

/**
 * Relative times are quicker to scan than absolute dates when comparing many records, such
 * as access tokens or browser sessions.
 */
export function formatRelativeTime(value: string): string {
    const seconds = (Date.parse(value) - Date.now()) / 1000;

    for (const [unit, size] of relativeTimeUnits) {
        if (Math.abs(seconds) >= size) {
            return relativeTimeFormat.format(Math.round(seconds / size), unit);
        }
    }

    return relativeTimeFormat.format(0, "minute");
}

/** Shows the scannable relative time while keeping the exact timestamp one hover away. */
export function RelativeTime(props: { value: string | null }) {
    if (props.value === null) {
        return <span className="text-slate-400">Never</span>;
    }

    return (
        <Tooltip content={new Date(props.value).toLocaleString()}>
            <time dateTime={props.value}>
                {formatRelativeTime(props.value)}
            </time>
        </Tooltip>
    );
}
