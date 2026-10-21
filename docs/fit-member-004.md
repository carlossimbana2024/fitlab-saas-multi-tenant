# FIT-MEMBER-004 — Condiciones económicas por contratación

La migración 0050 fue confirmada por el usuario como aplicada en Supabase, junto con su prueba SQL. Esta etapa integra su lectura en la API y en los portales. No incluye lista de espera (FIT-MEMBER-005), resolución manual ni cambios de catálogo.

## Fuente de verdad

- Las reservas nuevas capturan modalidad, importe, moneda y fecha en una versión dentro de la misma transacción. El cliente no suministra el precio cobrado.
- Una contratación existente consulta `class_booking_terms`. El catálogo solo propone las condiciones de una nueva contratación.
- `economic_terms` contiene la versión actual; `economic_history` conserva las versiones anteriores. Cancelar y volver a reservar puede reutilizar la fila de reserva, pero añade otra versión.
- `payment_summary` representa dinero registrado. No sustituye una cotización original desconocida.
- El backend deriva `payment_state` y `can_collect_payment`. Las RPC y los triggers validan nuevamente las condiciones al cobrar.

## Históricos y acceso

Las condiciones históricas verificadas proceden exclusivamente de evidencia de contratación inequívoca. Una modalidad incluida demostrada puede conservar moneda desconocida. Una reserva pagada con condiciones desconocidas conserva pago e historial; una reserva pendiente sin condiciones verificables no admite cobro automático.

La API filtra primero las reservas por gimnasio y, para miembros, por identidad. Los términos se cargan mediante la relación de cada reserva. Los coaches de sesiones asignadas reciben el estado de pago y conservan el control de asistencia; no reciben importes cobrados ni el historial financiero. Los recibos muestran el importe del pago y las condiciones originales por separado.

La resolución manual queda preparada en el modelo de datos, pero no existe todavía una interfaz/RPC para efectuarla. No deben editarse ni reemplazarse condiciones antiguas utilizando el catálogo.

## Validación y prueba manual

Las pruebas de `activityEconomics.test.ts` cubren DTO, privacidad, versiones, datos desconocidos, cobro sin precio proporcionado por el cliente, recibos y renderizado real de las tarjetas del miembro y la lista de recepción. Se ejecutan también las regresiones 001–003. El test anterior de referencias solo amplía sus dependencias de renderizado para usar los componentes compartidos reales.

Para comprobar el flujo desde los portales, usar una sesión de prueba futura con cupos y miembros con cobertura:

1. Configurar precio $5 y reservar con el miembro A.
2. Cambiar a $8 y reservar con el miembro B. A debe ver $5 y B $8.
3. Abrir recepción y registrar el pago de A: el formulario y el recibo deben mostrar $5.
4. Probar incluida → adicional y adicional → incluida con reservas distintas. Las condiciones anteriores deben conservarse y el cobro debe seguirlas.
5. Cancelar una reserva sin pago y volver a reservar después de cambiar el precio. Consultar «Historial de contrataciones»: ambas versiones deben aparecer, una cancelada.
6. Consultar un histórico desconocido: debe indicarlo, sin sustituirlo por el precio del catálogo. Si ya tenía pago confirmado, debe seguir mostrándolo. Si estaba pendiente, no debe aparecer «Registrar pago».
7. Revisar un miembro de otro gimnasio y un coach sin permisos financieros: no deben acceder a condiciones/pagos ajenos.

Estas comprobaciones en navegador requieren la versión del backend y frontend que incorpora esta integración. Ejecutar únicamente 0050 en Supabase no publica los cambios de interfaz.

## Dependencia de FIT-MEMBER-005

La entrada en lista de espera no equivale a una contratación ni congela un precio. Cuando se implemente su corrección funcional, la confirmación debe respetar los mecanismos transaccionales de reserva y su captura de condiciones. No se cambia ese flujo en FIT-MEMBER-004.
