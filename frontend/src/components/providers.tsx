"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { HostedDemoGate } from "@/components/hosted-demo-gate";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <HostedDemoGate>
            <AuthProvider>
                <UserProfileProvider>
                    {children}
                </UserProfileProvider>
            </AuthProvider>
        </HostedDemoGate>
    );
}
