"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SiteLogo } from "@/components/site-logo";
import { PoweredByCase } from "@/app/components/shared/PoweredByCase";

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

type DemoStatus = {
    enabled: boolean;
    hosted_demo_configured: boolean;
    disabled_landing: boolean;
    budget_usd: number;
};

export function HostedDemoGate({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<"checking" | "enabled" | "disabled">("checking");

    useEffect(() => {
        const controller = new AbortController();
        fetch(`${API_BASE}/demo-status`, {
            cache: "no-store",
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) return null;
                return (await response.json()) as DemoStatus;
            })
            .then((status) => {
                setStatus(status?.disabled_landing ? "disabled" : "enabled");
            })
            .catch((error) => {
                if ((error as { name?: string }).name !== "AbortError") {
                    setStatus("enabled");
                }
            });

        return () => controller.abort();
    }, []);

    if (status === "checking") return <HostedDemoStatusShell />;
    if (status === "disabled") return <HostedDemoDisabledLanding />;

    return <>{children}</>;
}

function HostedDemoStatusShell() {
    return (
        <main className="min-h-dvh bg-white px-6 py-10 text-gray-900">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
                <SiteLogo size="md" asLink />
                <PoweredByCase />
            </div>
        </main>
    );
}

function HostedDemoDisabledLanding() {
    return (
        <main className="min-h-dvh bg-white px-6 py-10 text-gray-900">
            <div className="mx-auto flex min-h-[calc(100dvh-5rem)] max-w-3xl flex-col">
                <div className="flex items-center justify-between gap-4">
                    <SiteLogo size="md" asLink />
                    <PoweredByCase />
                </div>

                <section className="flex flex-1 flex-col justify-center py-20">
                    <p className="mb-4 text-sm font-medium uppercase text-gray-400">
                        Hosted demo paused
                    </p>
                    <h1 className="max-w-2xl font-serif text-4xl font-medium leading-tight text-gray-950 md:text-6xl">
                        This is the case.dev powered version of MikeOSS.
                    </h1>
                    <p className="mt-6 max-w-2xl text-base leading-7 text-gray-600 md:text-lg">
                        The public hosted demo is temporarily paused while we tune access and usage. The open-source fork remains available, and local installs can connect their own Case.dev API key.
                    </p>
                    <div className="mt-8 flex flex-wrap items-center gap-3">
                        <Link
                            href="https://github.com/CaseMark/mikeoss-casedotdev"
                            className="inline-flex h-10 items-center rounded-md bg-gray-950 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-800"
                        >
                            View GitHub repo
                        </Link>
                        <Link
                            href="https://case.dev"
                            className="inline-flex h-10 items-center rounded-md border border-gray-200 px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
                        >
                            Learn about case.dev
                        </Link>
                    </div>
                </section>
            </div>
        </main>
    );
}
