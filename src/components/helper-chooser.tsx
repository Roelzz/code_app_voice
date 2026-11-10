import { useState } from "react";
import { Bot, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DFMEA_HELPERS, getHelper, type HelperId } from "@/connectors/dfmea-helpers";

export function HelperChooser({ selected, disabled, restoreFocus = false, onSelect, onReset }: {
  selected: HelperId;
  disabled: boolean;
  restoreFocus?: boolean;
  onSelect: (id: HelperId) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" className="h-auto w-full justify-start whitespace-normal py-3 text-left" disabled={disabled} autoFocus={restoreFocus}>
            <Bot aria-hidden="true" className="shrink-0" />
            <span><span className="block text-xs font-normal text-muted-foreground">Selected helper · Change</span>{getHelper(selected).name}</span>
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Choose your DFMEA helper</DialogTitle>
            <DialogDescription>Used for typed requests and realtime voice. Changing helpers ends voice and starts a separate conversation.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3" role="group" aria-label="DFMEA helpers">
            {DFMEA_HELPERS.map((helper) => (
              <Button key={helper.id} type="button" variant="outline" aria-pressed={selected === helper.id}
                disabled={disabled}
                className={`h-auto justify-start whitespace-normal p-4 text-left ${selected === helper.id ? "border-primary bg-primary/5" : ""}`}
                onClick={() => { if (helper.id !== selected) onSelect(helper.id); setOpen(false); }}>
                <span>
                  <span className="block font-semibold">{helper.name}{selected === helper.id ? " · Selected" : ""}</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">{helper.description}</span>
                </span>
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Only the chosen helper receives requests. No automatic fallback. Suggestions still need team review.</p>
        </DialogContent>
      </Dialog>
      <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={onReset}>
        <RotateCcw aria-hidden="true" />New conversation
      </Button>
    </div>
  );
}
