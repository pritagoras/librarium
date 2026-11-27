# Librarium

Tu biblioteca personal y cuaderno de lectura: guardá tus libros, notas, anotaciones con fotos y citas, y conversá con una IA sobre cualquier pasaje.

**Usala directamente:** https://pritagoras.github.io/librarium/ (funciona en el celular y en la computadora, sin instalar nada).

## Empezar en 3 pasos
1. Abrí el link y tocá **＋ Añadir** para cargar tu primer libro (a mano, buscándolo en Open Library o escaneando el ISBN).
2. Agregá notas, citas o anotaciones con foto mientras leés.
3. Para usar la IA, pegá tu clave de Gemini en **⚙ Ajustes → Ajustes de IA** (ver abajo).

### Instalarla como aplicación
- **Android (Chrome):** menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** botón Compartir → *Agregar a pantalla de inicio*.
- **Computadora (Chrome/Edge):** ícono de instalar en la barra de direcciones, o *Ajustes → Instalar Librarium*.

Instalarla en el iPhone es importante: Safari puede borrar los datos de los sitios que no se usan por un tiempo, y las aplicaciones instaladas están más protegidas.

## Funciones
- Biblioteca con estados de lectura, puntuación, reseña, etiquetas y progreso diario.
- Carga manual, búsqueda en Open Library y escaneo de ISBN con la cámara.
- Importación de notas finales desde JSON (ver formato más abajo), con secciones cuando la numeración reinicia.
- Notas, anotaciones con fotografías y citas (con transcripción de fotos por IA).
- **Chat con IA a pantalla completa**: mantené apretada una nota, anotación o cita (o tocá el ícono ✦) para conversar sobre ella. La charla se guarda y podés retomarla.
- **Conversaciones con la IA**: desde la Biblioteca, un banner abre la lista de todas tus charlas agrupadas por libro, con buscador.
- La IA pasa sola a otro modelo si el elegido falla, se traba o corta la respuesta.
- **Personajes**: dentro de cada libro, la pestaña *Personajes* permite crear fichas (nombre y alias, edad, descripción y rasgos, ocupación, pertenencia, comentarios, fuentes y certeza de cada dato), relacionarlas entre sí (familiar, amistad, rivalidad, alianza, mentoría u otro tipo editable), recorrerlas en lista, tabla o red de relaciones, y consultar a la IA sobre la ficha, un campo o un vínculo (ver abajo).
- Ficha del libro y etiquetas sugeridas, síntesis de ideas y borrador de reseña con IA.
- **Búsqueda global** (botón *🔍 Buscar* o Ctrl+K): encuentra palabras en libros, notas, anotaciones, citas, personajes y charlas con la IA, sin distinguir tildes ni mayúsculas, y lleva al registro. No usa IA ni envía datos.
- Modo oscuro, copia de seguridad y restauración.

## Cómo conseguir tu clave de Gemini (gratis)
La IA no tiene una clave compartida: cada persona usa la suya.
1. Entrá a https://aistudio.google.com/apikey con tu cuenta de Google.
2. Creá una clave y copiala.
3. Pegala en **⚙ Ajustes → Ajustes de IA** y guardala.

La clave queda guardada **solo en el navegador de ese dispositivo, sin cifrar**, y no se incluye en copias de seguridad ni en la sincronización. No la compartas ni la uses en una computadora que no sea tuya. El plan gratuito de Google tiene límites de uso diarios; si te quedás sin cupo, esperá o probá con otro modelo.

## Personajes
- **Crear una ficha**: *Libro → Personajes → ＋ Nuevo personaje*. Solo el nombre es obligatorio. Lo que dejes en blanco queda como «desconocido» y nunca se completa solo; si cargás un dato, indicás si es **explícito en el libro** o **inferido**. Dos personajes del mismo libro no pueden llamarse igual.
- **Crear un vínculo**: en la ficha, *＋ Agregar vínculo*. Elegís al otro personaje, el tipo, una descripción, fuentes y la certeza. No se permiten vínculos duplicados (el mismo tipo entre las mismas dos personas, en cualquier sentido; *Mentoría* sí distingue quién es el mentor). Desde la ficha podés abrir la del otro personaje, editar o quitar el vínculo.
- **Vistas**: lista, tabla y red. La red parte de un personaje y muestra hasta 10 vínculos por nodo; con «Mostrar sus vínculos» se expande por partes. No hace falta para gestionar las fichas.
- **IA**: los botones de la ficha completa, el nombre y los vínculos usan la misma clave y modelo de *Ajustes de IA*. En esas consultas se envían los datos de la ficha y los vínculos relacionados; además, solo las notas, anotaciones y citas que mencionan al personaje (hasta 12 por tipo), con página conocida hasta tu avance. Las consultas puntuales de edad, descripción, ocupación o pertenencia usan solo el conocimiento general del modelo, sin notas ni búsqueda web, y guardan la respuesta como inferida. Los datos de fichas y vínculos no tienen página asociada y pueden incluir spoilers si los cargaste. **No se envía el texto completo del libro**. Revisá cada respuesta antes de guardarla.
- **Analizar la red**: con tu clave guardada consulta a Gemini y deja todas las propuestas pendientes hasta que las revises; sin clave prepara un prompt para usar manualmente. Envía nombres, alias, tipos de vínculos y hasta 40 notas, anotaciones y citas paginadas por tipo hasta tu avance. Omite descripciones y fuentes sin página. La IA puede proponer relaciones y personajes por conocimiento general cuando el cuaderno no alcanza; se muestran como inferencias y quedan para tu revisión. Si una propuesta dice basarse en tu cuaderno, debe citar una referencia paginada válida. La búsqueda web opcional se usa para desambiguar nombres, no como evidencia de relaciones.
- **Buscar familiares**: solo comparte hasta 12 notas, anotaciones y citas por tipo que mencionan a ese personaje y tienen página hasta tu avance. Las propuestas deben citar una de esas fuentes para poder incorporarse.
- **Animar mi red**: en la vista *Red*, la red se reordena y se forma en vivo, personaje por personaje. Desde ahí podés crear un video o un GIF y compartirlo (por ejemplo, por WhatsApp). Solo muestra el título, los nombres y los tipos de vínculo (hasta 30 personajes). No usa IA ni envía datos.
- **Hacer crecer con IA**: parte de tus personajes (alcanza con uno, o con ninguno) y propone quiénes aparecieron hasta tu página y cómo se vinculan. Usa tu clave de Gemini y envía el libro, los nombres, vínculos y hasta 60 notas, anotaciones y citas con página. Elegís qué agregar y la red se forma en pantalla. Los personajes nuevos llegan con una ficha inicial (edad, ocupación y descripción breve) marcada como inferida. La IA puede equivocarse o adelantar algo.
- **Datos**: las fichas y los vínculos se guardan en el dispositivo, se sincronizan con la cuenta, entran en la copia de seguridad y se borran junto con el libro. Al restaurar una copia no se duplican (los vínculos se identifican por libro, tipo y extremos).

## Tus datos y tu privacidad
- **Sin iniciar sesión**, todo se guarda únicamente en tu navegador (IndexedDB). No se envía a ningún servidor de Librarium.
- **Al iniciar sesión con Google**, tus libros, notas, citas, fotos y conversaciones se sincronizan con la base de datos del proyecto Librarium (Firebase), para que puedas usarlos en varios dispositivos. Si preferís que nada salga de tu dispositivo, no inicies sesión.
- Si dos dispositivos cambian el mismo registro, Librarium conserva ambas versiones y muestra **Revisar conflictos** en el estado de sincronización. Si una escritura falla, queda pendiente en este dispositivo y se reintenta al recuperar la conexión.
- **Al usar la IA**, el texto y las fotos que consultás (en Personajes, la ficha y tus notas que los mencionan) se envían a Google (Gemini) con tu propia clave.
- **Preguntar a la IA**: las respuestas completas terminan con una frase clave breve y directa. Podés guardar la respuesta completa debajo de tu comentario; queda plegada bajo la pregunta que la originó. También podés guardar solo la frase clave como anotación. Ambas opciones se conservan al sincronizar y en las copias de seguridad, aparecen en la búsqueda y se pueden borrar desde el elemento. Las respuestas incompletas no muestran una frase clave.
- La búsqueda de libros usa Open Library y las portadas por URL se descargan desde el proveedor indicado.

**Hacé copias de seguridad.** En *⚙ Ajustes → Copia de seguridad* se descarga un JSON con todo (libros, notas, anotaciones, imágenes, personajes, vínculos y conversaciones). *Restaurar copia* incorpora o actualiza los registros por ID, sin borrar los datos actuales. No borres los datos del sitio si no tenés una copia.

## Formato JSON de notas
```json
{
  "schema_version": 1,
  "book": {"title": "Título del libro", "author": "Autor"},
  "notes": [
    {
      "number": 1,
      "reference_page": 12,
      "end_page": 245,
      "text": "Texto de la nota",
      "read": false
    }
  ]
}
```
También acepta `referencePage` y `endPage` en camelCase. `reference_page` es opcional: omitilo (o usá `null`) cuando las notas no tengan una página de referencia en el texto principal. `end_page` es la página donde aparece la nota y también puede omitirse o ser `null`. Al importar, se agregan al libro abierto. Si la numeración reinicia (por ejemplo, vuelve de 25 a 1), se crea una sección nueva.

## Para desarrolladores
Requiere Node.js 22 o superior.

```bash
npm install
npm run dev      # servidor de desarrollo en http://127.0.0.1:8765
npm run build    # genera dist/
npm run analyze  # muestra qué módulos ocupan más espacio en cada paquete
npm run lint     # chequeo de tipos y reglas de Firestore
npm run test     # pruebas de importación, restauración, conflictos de sincronización y personajes (fichas, vínculos, respaldo y contexto para la IA)
```

En Windows también podés usar `INSTALAR.bat` (una vez) e `INICIAR_LIBRARIUM.bat`.

### Publicar en GitHub Pages
El flujo de GitHub Actions incluido publica el sitio en cada cambio a `main`. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### Usar tu propio Firebase
La sincronización usa la configuración de `firebase-applet-config.json`. Si publicás tu propia copia, creá tu proyecto de Firebase, reemplazá ese archivo, agregá tu dominio en *Authentication → Dominios autorizados* y publicá las reglas de `firestore.rules` en tu base de datos. Más detalle de las reglas en `security_spec.md`.

## Limitaciones
- La búsqueda de libros y la IA necesitan internet.
- Las portadas por URL dependen de que el proveedor siga disponible.
- Las imágenes van incluidas en la copia de seguridad, que puede volverse grande.
- Las notas de voz todavía no están disponibles.
