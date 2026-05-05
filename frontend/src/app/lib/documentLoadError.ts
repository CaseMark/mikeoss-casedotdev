const DEMO_BUDGET_EXCEEDED_MESSAGE =
    "This account has reached its demo credit limit. Add your own Case.dev key in Account > Models or ask the demo operator to reset your budget.";

export async function documentLoadError(response: Response): Promise<Error> {
    let message = `HTTP ${response.status}`;
    try {
        const body = (await response.json()) as {
            code?: string;
            detail?: string;
            error?: string;
        };
        if (body.code === "demo_budget_exceeded") {
            message = DEMO_BUDGET_EXCEEDED_MESSAGE;
        } else {
            message = body.detail ?? body.error ?? message;
        }
    } catch {
        /* keep HTTP fallback */
    }
    return new Error(message);
}
