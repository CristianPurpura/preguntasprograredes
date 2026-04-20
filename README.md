# Preguntas PDF

Aplicación web en React + Vite que lee el archivo [Preguntas.pdf](Preguntas.pdf), separa las preguntas por bloques de 10 y muestra feedback inmediato con la respuesta correcta y la explicación de por qué lo es o por qué una opción incorrecta no lo es.

## Cómo usar

1. Instala dependencias con `npm install`.
2. Arranca el proyecto con `npm run dev`.
3. La app cargará automáticamente el PDF del proyecto.
4. Responde las preguntas del bloque actual y pulsa `Siguiente bloque` cuando termines.

## Notas

- El PDF se procesa en el navegador con PDF.js.
- Cada pregunta muestra la corrección en cuanto eliges una opción.
- El resumen final muestra cuántas respuestas fueron correctas e incorrectas.