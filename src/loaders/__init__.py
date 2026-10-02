"""
Reading what a reader sees. The API's routes call these; nothing here
calls an LLM — the worker has written everything in advance.

  watch     the Watch: story cards and single rows from the reader's
            monitors, in the time window
  library   what the reader kept: saved stories, a folder's contents
  account   what the reader set up: filterable monitors, views, folders
  monitors  the monitors the reader follows, with their health and runs
  stories   the story layer the three share: label, synthesis, origin
            and timeline in the reader's language, and the reader's state
  common    parsing, recency ordering, and the title and summary a
            reader is shown
"""
