"use client";

import React, { createContext, useContext, useEffect, ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

interface User {
    id: string;
    email: string;
}

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const { data: session, isPending, refetch } = authClient.useSession();
    const authUser = session?.user;
    const userId = authUser?.id ?? null;
    const user: User | null = userId
        ? {
              id: userId,
              email: authUser?.email || "",
          }
        : null;

    useEffect(() => {
        if (!userId) return;
        const apiBase =
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
        fetch(`${apiBase}/user/profile`, {
            method: "POST",
            credentials: "include",
        }).catch((e) => {
            console.log(e);
        });
    }, [userId]);

    const signOut = async () => {
        await authClient.signOut();
        await refetch();
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuthenticated: !!user,
                authLoading: isPending,
                signOut,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
