# Interface ideas

One hundred possible changes to how deskmate looks and behaves, from a pass over every part of the interface on 2026-10-12. Each is one change, not a plan. The thirteen marked ✔ were built in that pass: the first three had already been agreed, and the other ten were picked because each removes something a person hits in ordinary use and needs no change to the hub.

## The tag list that opens on `@`

1. ✔ Hold clone offers back until part of a repo name has been typed.
2. ✔ End the list with "N more, keep typing" when it has been cut short.
3. ✔ Put repos you also have ahead of ones you lack.
4. ✔ In a direct chat, put the other person's agents ahead of everyone else's.
5. ✔ Show the list's own keys in the bottom bar while it is open.
6. Let the list scroll past eight rows instead of stopping.
7. Remember which agents you tagged last in each chat, and lead with them.
8. Match letters in order, so `@jthm` finds `jacob/theme`.
9. Mark agents whose owner is away, so you know the request will sit.
10. Mark an agent that is already working on something.
11. Make Tab complete as far as the choices agree, like a shell, instead of taking the top row.
12. Accept `@me/repo` for your own agents.
13. In a channel with a pinned repo, turn `@bob` followed by a space into `@bob/that-repo`.
14. Let a tag of a person with no repo (`@bob`) ring their bell and pick the note out for them.

## The message box

15. ✔ Make a draft under review unmistakable: the prompt becomes `✎` and the box gets room to read the answer.
16. Review a long draft full-screen, with the question above it.
17. ✔ Bring back your last message in that chat with ↑ on an empty box.
18. ✔ Make "Enter send" in the bottom bar clickable.
19. Keep half-typed messages across restarts.
20. Keep unsent drafts across restarts.
21. Preview a draft as rendered Markdown before sending.
22. Add slash commands: `/join`, `/pin`, `/leave`, `/who`.
23. Show a count when a message nears the 64,000-character limit.
24. Ask before sending a very large paste.
25. Send typing to the message box wherever the pointer last clicked.
26. Clear a half-typed message with Esc twice, the same gesture that discards a draft.

## Notes in a chat

27. ✔ Show "── new ──" where you left off.
28. Show "↓ 3 new" when notes arrive while you are scrolled up, and jump on click.
29. Fold a long agent answer after about twenty lines, with "show more".
30. Add a copy action to each code block.
31. Add a copy action to a whole agent answer.
32. Jump to the quoted note when its quote line is clicked.
33. Show the full date when the pointer is over a time.
34. Give agent answers a coloured left edge, so agent and human text differ at a glance.
35. Show on an answer how long the agent took.
36. Make addresses in typed notes clickable.
37. Pick out `path/file.py:12` and open it in your editor on click.
38. Style `inline code` in typed notes without rendering the rest as Markdown.
39. Load older notes when you scroll to the top.
40. Search within a chat.
41. Add a line to the chat when someone joins, leaves, or pins a repo.
42. In an empty direct chat, suggest a first tag using one of that person's repos.
43. Select a note with the keyboard, to act on any request and not only the oldest.
44. Show a quoted note in full when the pointer is over its quote.
45. Show times within the last hour as "5m ago".
46. Fold a run of agent activity with no answers into one line.

## Requests under a note

47. Show how long a request has waited.
48. Say when an away teammate was last here.
49. Let the asker withdraw a request.
50. Let the asker nudge once after a long wait.
51. Let the owner decline with a short reason.
52. Let the owner add an instruction for their agent before running it.
53. Show the owner exactly what their agent will be told.
54. Offer single-key choices (R, P, D) when a request is selected.
55. Shrink the choices to symbols when the pane is narrow.
56. Show the owner why a run failed, with "run again".
57. Show the owner what the agent is writing while it works.
58. Let an owner approve in advance: "always run for jacob in this repo".

## The chat list

59. ✔ Hide and show the chat list, for narrow terminals.
60. Hide it automatically below about seventy columns.
61. Sort chats with something waiting to the top.
62. Jump to the next chat that needs you with one key.
63. Open the nth chat with Alt+1 to Alt+9.
64. Show the pinned repo beside a channel's name.
65. Show a count beside `▶` when several requests wait.
66. Dim people who are away.
67. Mute a channel.
68. Mark everything read.
69. Resize the list by dragging its border.
70. Show a person's presence and repo count in their chat's title.

## The top and bottom bars

71. ✔ Put what needs you in the terminal tab's title.
72. Add a "my agents" view of what you are sharing, with a way to hold a repo back.
73. Count down to the next retry when the hub is unreachable.
74. Always keep `F1 help` at the end of the hints.
75. Show the hub's and the client's versions, and warn when they differ.
76. Retry at once when the connection state is clicked.
77. Show your own branch of a channel's pinned repo in the top bar.
78. Show a taskbar progress mark while one of your agents works.

## Dialogs

79. Join: narrow the list of channels as you type, and show each one's pinned repo.
80. Join: move from the name field into the list with ↓.
81. Pin: show each repo's branch, and start on the one already pinned.
82. Clone: show progress and allow cancelling.
83. Clone: offer to tag the new agent when it finishes.
84. Leave: ask before leaving a channel.
85. Help: add worked examples of tags.
86. First run: a short welcome that explains `@`, counts your repos, and gives the install line to share.

## Sound and notices

87. ✔ Ring only for direct notes and tags of your agents, not for channel chatter.
88. Ask the terminal for a desktop notification when your agent is tagged.
89. Open a chat when its notice is clicked.
90. Add a quiet mode that silences the bell.
91. Fold several notices from one chat into one.
92. Keep a notice about a waiting request on screen until it is handled.

## Quitting and errors

93. ✔ Ask once more before quitting while an agent works or a draft is unsent.
94. Show the chats from last time at once on start, then catch up.
95. Say plainly when the hub is a different version.
96. After a crash, print where the details were written.

## The command line

97. Add `deskmate ask @bob/uploader "…"`: send, then wait for that agent's answer and nothing else.
98. Make `--wait` report "waiting" and "working on main" as the request moves.
99. Add `--json` to `inbox` and `repos` for scripts.
100. Add `deskmate status`: the hub, your name, the repos you share, and the requests waiting.
