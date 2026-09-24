// Re-export the simulator's own request types so we never drift from upstream.
export type {
	ChoiceRequest, MoveRequest, SwitchRequest, TeamPreviewRequest, WaitRequest,
	PokemonSwitchRequestData, PokemonMoveRequestData, MoveRequestData,
} from 'pokemon-showdown/dist/sim/side.js';
