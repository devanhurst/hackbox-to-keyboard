import { encodeBinding } from "./layouts";
import type { Binding, ButtonDef, Layout } from "./layouts";

const TAP_EVENT = "tap";

function buttonHeight(count: number): string {
  if (count <= 1) return "70vh";
  return `${Math.max(10, Math.floor(80 / count))}vh`;
}

function fontSize(count: number): string {
  if (count <= 2) return "3rem";
  if (count <= 4) return "2rem";
  return "1.4rem";
}

export function emptyState(headerText: string) {
  return {
    ui: {
      header: { text: headerText },
      main: {
        align: "center" as const,
        components: [
          {
            type: "Text",
            props: {
              text: "Waiting for host…",
              style: {
                align: "center",
                border: "none",
                color: "#EEE",
                background: "transparent",
                fontSize: "1.5rem",
                fontFamily: "Fredoka One",
              },
            },
          },
        ],
      },
    },
  };
}

export function layoutState(
  headerText: string,
  layout: Layout,
  resolve: (button: ButtonDef) => Binding | null,
) {
  const count = layout.buttons.length;
  const height = buttonHeight(count);
  const size = fontSize(count);

  const components = layout.buttons.map((b) => ({
    type: "Button",
    props: {
      event: TAP_EVENT,
      value: encodeBinding(resolve(b)),
      label: b.label,
      persistent: true,
      keys: b.playerKey ? [b.playerKey] : ([] as string[]),
      style: {
        width: "100%",
        height,
        fontSize: size,
        fontFamily: "Open Sans",
        background: b.color,
        color: "#fff",
        border: "none",
        borderRadius: "1rem",
      },
    },
  }));

  return {
    ui: {
      header: { text: headerText },
      main: {
        align: "center" as const,
        components,
      },
    },
  };
}
