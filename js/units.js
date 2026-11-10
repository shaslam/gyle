// Small re-export so the format converters share one import.
export { lovibondToSrm, srmToEbc, ebcToSrm, srmToLovibond, platoToSg, yieldToPotential, potentialToYield } from './calc.js';
import { findStyle } from './data.js';
export const findStyleSafe = name => findStyle(name);
