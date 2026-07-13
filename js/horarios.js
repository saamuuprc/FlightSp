/* Horario orientativo de temporada del Aeropuerto de León (LELN)
   Fuente: programación observada (temporada verano 2026, actualizado 13-jul-2026).
   Air Nostrum (ANE) opera todos los vuelos comerciales con CRJ.
   Para editar: cambia horas/días aquí y sube este archivo (y sw.js con versión nueva).
   days: 0=domingo, 1=lunes ... 6=sábado */
'use strict';

const LELN_SCHEDULE = {
  updated: '2026-07-13',
  flights: [
    { type: 'arr', time: '10:50', apt: 'BCN', city: 'Barcelona',        cs: 'ANE2470', days: [0, 1, 2, 3, 4, 5, 6] },
    { type: 'dep', time: '11:30', apt: 'BCN', city: 'Barcelona',        cs: 'ANE2471', days: [0, 1, 2, 3, 4, 5, 6] },
    { type: 'arr', time: '18:00', apt: 'PMI', city: 'Palma de Mallorca', cs: 'ANE2462', days: [0, 1, 2, 3, 4, 5, 6], variable: true },
    { type: 'dep', time: '18:40', apt: 'PMI', city: 'Palma de Mallorca', cs: 'ANE2463', days: [0, 1, 2, 3, 4, 5, 6], variable: true },
    { type: 'arr', time: '20:10', apt: 'PMI', city: 'Palma de Mallorca', cs: 'ANE2476', days: [0, 1, 2, 3, 4, 5, 6], variable: true },
    { type: 'dep', time: '21:10', apt: 'PMI', city: 'Palma de Mallorca', cs: 'ANE2477', days: [0, 1, 2, 3, 4, 5, 6], variable: true },
  ],
  // Rutas de baja frecuencia (aprox. semanales, días y horas cambiantes)
  weekly: 'Además, ~1 vuelo semanal a Ibiza, Menorca, Gran Canaria, Málaga y Tenerife (días y horas variables).',
};
