export type ModeOutput<T = unknown> = {
    outcome: "achieved" | "retry" | "abandoned";
    payload: T;
};
