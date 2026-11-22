"use client";

import { createContext } from "react";

/**
 * The seat to open on when a table's tray was opened from a seat's card on the floor plan. The floor
 * plan provides it around the server-built table panel; the seat chips read it once when they mount.
 * Null when the tray was opened from the table itself, or from the list view.
 */
export const SeatFocusContext = createContext<number | null>(null);
