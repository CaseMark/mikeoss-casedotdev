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

interface PoweredByCaseProps {
    className?: string;
}

export function PoweredByCase({ className }: PoweredByCaseProps) {
    return (
        <a
            href="https://case.dev"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Powered by case.dev"
            className={cn(
                "inline-flex items-center gap-1.5 text-[11px] font-medium leading-none text-gray-400 transition-colors hover:text-gray-600",
                className,
            )}
        >
            <span>powered by case.dev</span>
            <span
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 bg-current"
                style={logoMaskStyle}
            />
        </a>
    );
}
