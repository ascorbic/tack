// What time it is, for relative times ("2 hr ago") and timestamps the
// client makes itself. The playground moves it forward to show what a
// board looks like after days away; everywhere else it's just the time.

export const clock = {
	now: (): number => Date.now(),
};
