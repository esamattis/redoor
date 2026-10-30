import { useAtom } from "jotai";
import { CircleAlert } from "lucide-react";
import { Toast } from "#ui/components/toast";
import { userStatePersistErrorAtom } from "#ui/user-state";

/** Announces a failed preference write without blocking the optimistic UI update. */
export function UserStatePersistToast() {
    const [message, setMessage] = useAtom(userStatePersistErrorAtom);

    if (!message) {
        return null;
    }

    return (
        <Toast
            tone="error"
            icon={<CircleAlert className="h-4 w-4" />}
            dismissAriaLabel="Dismiss settings save error"
            onDismiss={() => setMessage(null)}
        >
            {message}
        </Toast>
    );
}
