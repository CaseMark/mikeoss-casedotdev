import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const logoMaskStyle: CSSProperties = {
    maskImage: "url('/casedev-logo.svg')",
    WebkitMaskImage: "url('/casedev-logo.svg')",
    maskPosition: "center",
    WebkitMaskPosition: "center",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskSize: "contain",
};

const SOURCE_URL = "https://github.com/CaseMark/mikeoss-casedotdev";

interface PoweredByCaseProps {
    className?: string;
}

export function PoweredByCase({ className }: PoweredByCaseProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-2 text-[11px] font-medium leading-none text-gray-400",
                className,
            )}
        >
            <a
                href="https://case.dev"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Powered by case.dev"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-gray-600"
            >
                <span>powered by case.dev</span>
                <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 bg-current"
                    style={logoMaskStyle}
                />
            </a>
            <span aria-hidden="true" className="text-current/40">
                /
            </span>
            <a
                href={SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-gray-600"
            >
                Source
            </a>
        </span>
    );
}
