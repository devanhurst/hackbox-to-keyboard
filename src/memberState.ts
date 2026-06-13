// The member state we push to each player: a single full-screen button.
//
// Shape mirrors what the hackbox client renders (state.ui.main.components) and
// what the server's sanitizeState expects. The Button component emits a `msg`
// event named by `props.event` when tapped — we listen for that on the host.
//
// The server merges this over a dark default theme (helpers.emptyMemberState),
// so we only need to specify what differs.
export function buttonState(name: string) {
  return {
    ui: {
      header: { text: name },
      main: {
        align: "center" as const,
        components: [
          {
            type: "Button",
            props: {
              event: "press",
              value: "press",
              label: "PRESS",
              keys: [] as string[],
              style: {
                width: "100%",
                height: "70vh",
                fontSize: "3rem",
                fontFamily: "Fredoka One",
                background: "#7c5cff",
                color: "#fff",
                border: "none",
                borderRadius: "1rem",
              },
            },
          },
        ],
      },
    },
  };
}
