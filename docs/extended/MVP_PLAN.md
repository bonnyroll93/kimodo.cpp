# Kimodo Extended --- MVP Implementation Plan

> **Documento di progetto**\
> Scopo: definire un MVP implementabile come fork di
> `localai-org/kimodo.cpp`, mantenendo intatto il comportamento
> originale e predisponendo l'architettura per le feature future.\
> Stato: proposta tecnica --- da verificare contro il commit
> effettivamente scelto come base del fork.

------------------------------------------------------------------------

## 1. Obiettivo

Estendere Kimodo.cpp con un primo workflow end-to-end che permetta di:

1.  caricare un personaggio riggato da **GLB/glTF**;
2.  visualizzare mesh e skeleton in una viewport 3D;
3.  generare motion con il motore Kimodo esistente;
4.  applicare **Motion In Place** oppure un **MotionPath** procedurale;
5.  trasferire il motion sullo skeleton importato tramite retargeting;
6.  comporre il risultato con un piccolo stack di **Animation Layers**;
7.  riprodurre e ispezionare il risultato nella viewport;
8.  esportare un GLB con mesh, skin e animazione, se supportato dalla
    pipeline di esportazione scelta.

L'MVP deve essere additivo: se le nuove opzioni non vengono abilitate,
l'inferenza e l'output originali devono rimanere invariati.

## 2. Non-obiettivi dell'MVP

Le seguenti funzionalità sono esplicitamente fuori scope per la prima
versione:

-   conditioning del denoiser sul MotionPath durante la diffusione;
-   generazione nativa su skeleton arbitrari;
-   training o fine-tuning di checkpoint;
-   import FBX;
-   rigging automatico di mesh prive di skeleton;
-   IK avanzata, foot locking e contact solving;
-   editor visuale completo con keyframe editing;
-   layer procedurali complessi, graph editor e animazioni annidate;
-   esportazione FBX.

Queste feature sono annotate nella sezione **Future Features**.

## 3. Principi architetturali

### 3.1 Separazione tra AI, motion e rendering

Mantenere tre responsabilità indipendenti:

-   **Kimodo Core:** carica il checkpoint e genera il motion nel formato
    nativo previsto dal modello.
-   **Motion Runtime:** converte, controlla, retargetta e combina le
    animazioni.
-   **Viewer:** visualizza mesh, skeleton, MotionPath e animazione; non
    implementa la logica di generazione.

Il renderer non deve diventare una dipendenza del core C++.

### 3.2 Formato interno indipendente

Introdurre un formato runtime neutro rispetto a GLB/FBX e rispetto al
renderer:

-   `Skeleton`: gerarchia, rest pose e identificatori dei joint;
-   `Pose`: trasformazioni locali per tutti i joint;
-   `AnimationClip`: sequenza temporale di pose o track per joint;
-   `AnimationLayer`: clip, peso, modalità di blend e maschera;
-   `MotionPath`: curva e parametri di percorrenza.

GLB è il primo formato di import/export dell'MVP. FBX viene aggiunto
successivamente tramite un backend dedicato.

### 3.3 Compatibilità

-   Non cambiare il layout dei pesi o la rappresentazione del
    checkpoint.
-   Non modificare il denoiser per le feature procedurali dell'MVP.
-   Non cambiare in modo incompatibile l'API C esistente.
-   Aggiungere nuove API C++ e, solo dove serve, funzioni C versionate.
-   Mantenere test di regressione per il percorso originale.

------------------------------------------------------------------------

## 4. Scope funzionale dell'MVP

### M1 --- Import GLB e visualizzazione mesh

**Obiettivo:** caricare un personaggio già riggato e mostrarlo nella
demo.

Funzionalità:

-   importare un file `.glb` contenente mesh, materiali, skin e
    skeleton;
-   visualizzare il modello con camera orbit, pan e zoom;
-   mostrare/nascondere skeleton helper;
-   selezionare un joint nella gerarchia o nel viewport;
-   mostrare nome, parent e trasformazione locale del joint selezionato;
-   visualizzare griglia e assi di riferimento.

Vincoli:

-   il modello deve contenere uno skeleton valido e skin weights;
-   niente rigging automatico;
-   per l'MVP il viewer può caricare il GLB direttamente nel browser con
    Three.js;
-   il backend C++ deve poter leggere lo stesso GLB per estrarre la
    definizione dello skeleton.

**Criteri di accettazione:**

-   un GLB riggato di test viene caricato senza perdita di gerarchia;
-   mesh e materiali sono visibili;
-   skeleton overlay può essere attivato/disattivato;
-   la selezione di un joint aggiorna l'inspector;
-   il viewer rimane utilizzabile senza avviare una generazione AI.

### M2 --- Skeleton abstraction e mapping manuale

**Obiettivo:** rappresentare lo skeleton importato in una struttura
interna indipendente dalla libreria di import.

Dati minimi per joint:

-   ID stabile all'interno dello skeleton;
-   nome originale;
-   indice del parent;
-   trasformazione locale di rest pose;
-   trasformazione globale di rest pose;
-   lunghezza/asse principale del bone, se ricavabile;
-   flag per root e joint deformante.

Prevedere un mapping esplicito tra joint sorgente Kimodo e joint target.
Il mapping automatico per nome può essere un aiuto, ma l'MVP deve
permettere la correzione manuale.

**Non assumere** che nomi, orientamenti locali o convenzioni degli assi
siano uguali tra rig diversi.

**Criteri di accettazione:**

-   skeleton importato e skeleton sorgente vengono rappresentati
    separatamente;
-   il mapping è salvabile/caricabile in JSON;
-   mapping incompleto o ambiguo produce un errore diagnostico, non un
    crash;
-   le rest pose sono disponibili al retargeter.

### M3 --- Motion In Place e Root Motion

**Obiettivo:** poter rimuovere la traslazione forward mantenendo il
movimento articolare.

Modalità MVP:

-   `Full`: conserva root motion originale;
-   `InPlace`: rimuove la traslazione orizzontale della root;
-   `CustomPath`: sostituisce la traiettoria root con il MotionPath.

Per `InPlace`:

-   conservare la posizione iniziale della root;
-   rimuovere solo gli assi orizzontali configurati;
-   preservare la componente verticale per quanto consentito dalla
    rappresentazione del checkpoint;
-   non modificare le rotazioni articolari;
-   rendere configurabile la convenzione degli assi up/forward.

**Criteri di accettazione:**

-   l'animazione in-place non accumula traslazione orizzontale;
-   le rotazioni delle gambe e del torso rimangono inalterate dal
    passaggio In Place;
-   la modalità Full produce lo stesso risultato del percorso originale,
    entro le tolleranze numeriche;
-   la conversione è deterministica.

### M4 --- MotionPath procedurale

**Obiettivo:** far seguire alla root una traiettoria definita
dall'utente dopo la generazione.

Tipologie incluse nell'MVP:

-   polyline/waypoints;
-   Catmull--Rom spline.

Bezier e curve parametriche possono essere aggiunte dopo che
l'interfaccia base è stabile.

Dati minimi:

-   punti del percorso;
-   parametro di avanzamento normalizzato;
-   durata oppure velocità;
-   orientamento lungo la tangente;
-   loop on/off.

Pipeline:

1.  generare il motion nativo;
2.  calcolare/normalizzare la progressione temporale;
3.  valutare il MotionPath per ogni frame;
4.  sostituire la traslazione della root;
5.  opzionalmente orientare la root lungo la tangente;
6.  lasciare invariata la posa articolare nel primo MVP.

**Importante:** questa prima versione è post-processing procedurale. Non
è AI conditioning e non garantisce automaticamente coerenza tra
lunghezza del passo e velocità della traiettoria.

**Criteri di accettazione:**

-   la root segue i waypoint nell'ordine previsto;
-   la tangente determina l'orientamento quando `orient_to_path` è
    attivo;
-   la durata del clip rimane configurabile;
-   i casi di tangente nulla, percorso degenerato e un solo waypoint
    sono gestiti;
-   un test verifica che In Place e CustomPath siano mutuamente
    esclusivi, salvo una modalità esplicita di preview.

### M5 --- Retargeting base

**Obiettivo:** trasferire un motion dal rig nativo al rig importato.

Implementare un retargeter basato su:

-   rest pose sorgente e target;
-   mapping joint esplicito;
-   conversione degli spazi locali;
-   offset di orientamento per joint;
-   scala delle traslazioni per la root e, se necessario, per joint
    selezionati.

Nel primo MVP limitare il supporto a skeleton umanoidi compatibili con
il rig sorgente supportato dal checkpoint scelto.

Non promettere supporto universale per robot, quadrupedi o gerarchie
radicalmente differenti.

**Criteri di accettazione:**

-   una clip sorgente viene applicata al rig target;
-   il target mantiene la propria gerarchia e skin;
-   la posa iniziale coincide con la rest pose target;
-   i joint non mappati mantengono la rest pose o seguono una policy
    esplicita;
-   sono disponibili test per assi invertiti, offset di rest pose e
    differenze di lunghezza degli arti.

### M6 --- Animation Layers essenziali

**Obiettivo:** comporre clip e modifiche per joint dopo il retargeting.

Feature incluse:

-   layer ordinati;
-   abilitazione/disabilitazione e mute;
-   peso 0--1;
-   modalità `Override` e `Additive`;
-   maschera per joint;
-   maschere predefinite Upper Body, Lower Body e Full Body;
-   maschera custom salvabile.

Rimandare `Multiply` e `Procedural` a una fase successiva: richiedono
semantiche precise per rotazione, traslazione e scala e non sono
necessarie per dimostrare il valore dell'MVP.

**Semantica proposta:**

-   `Override`: interpola la posa corrente verso la posa del layer
    usando il peso; per rotazioni usare interpolazione quaternion.
-   `Additive`: applica il delta rispetto alla reference pose del
    clip/layer; per rotazioni usare delta quaternion e composizione
    coerente con gli spazi scelti.
-   La maschera determina il peso effettivo per ciascun joint.
-   L'ordine dei layer è esplicito e testato.

Per l'MVP un layer può contenere un clip importato o un clip generato da
Kimodo. L'editing manuale dei keyframe non è incluso.

**Criteri di accettazione:**

-   un layer Upper Body non modifica i joint delle gambe;
-   peso 0 equivale a layer disattivato;
-   peso 1 applica il layer secondo la modalità selezionata;
-   mute ed enable producono risultati distinti e documentati;
-   la composizione è deterministica e testata su quaternion edge cases.

### M7 --- Timeline e preview

**Obiettivo:** controllare la riproduzione del risultato.

Funzioni:

-   play/pause;
-   scrub temporale;
-   loop;
-   visualizzazione durata e frame rate;
-   selezione del layer attivo;
-   aggiornamento in tempo reale della viewport.

La timeline MVP non consente ancora di spostare keyframe o creare curve
di animazione.

### M8 --- Export GLB

**Obiettivo:** esportare un singolo asset GLB contenente mesh, skeleton,
skin e clip finale.

Verificare che la libreria scelta supporti realmente:

-   mesh e materiali;
-   skin e inverse bind matrices;
-   gerarchia dei joint;
-   animazioni e interpolazione;
-   trasformazioni root.

Non presumere che una libreria di import sia anche un exporter completo.
Se l'exporter non preserva correttamente skin e animazioni, usare una
libreria di scrittura glTF dedicata.

**Criteri di accettazione:**

-   il GLB esportato si riapre nel viewer;
-   mesh e skin sono preservate;
-   l'animazione riprodotta corrisponde alla preview;
-   il test confronta posa iniziale, posa intermedia e posa finale.

------------------------------------------------------------------------

## 5. Struttura proposta dei moduli

La struttura esatta va adattata ai nomi e alle convenzioni già presenti
nel repository. Prima di creare file nuovi, controllare se esistono già
classi equivalenti (in particolare la rappresentazione skeleton e
l'export GLB).

``` text
include/kimodo/
  animation_clip.hpp
  animation_layer.hpp
  animation_mask.hpp
  animation_stack.hpp
  motion_path.hpp
  motion_control.hpp
  retargeting.hpp
  skeleton_types.hpp

src/
  motion/
    motion_path.cpp
    root_motion.cpp
    trajectory_solver.cpp

  skeleton/
    skeleton_adapter.cpp
    skeleton_import_glb.cpp
    bone_mapping.cpp
    retargeting.cpp

  animation/
    animation_clip.cpp
    animation_layer.cpp
    animation_mask.cpp
    animation_stack.cpp
    animation_blend.cpp
    animation_evaluator.cpp

  export/
    animation_export_glb.cpp

demo/
  viewer/
    viewport.js
    model-loader.js
    skeleton-view.js
    joint-selection.js
    animation-player.js
    motion-path-view.js

  editor/
    animation-layers.js
    layer-panel.js
    animation-mask.js
    timeline.js
    inspector.js
    scene-hierarchy.js
```

Non è necessario introdurre immediatamente tutte queste directory. La
priorità è stabilire le interfacce e poi collocare i file secondo la
struttura effettiva del progetto.

------------------------------------------------------------------------

## 6. Modello dati minimo

Le strutture seguenti sono uno schema concettuale: i tipi `Vec3`, `Quat`
e `Transform` devono riutilizzare le primitive matematiche già adottate
dal repository, evitando di introdurre una seconda math library senza
necessità.

``` cpp
struct Transform {
    Vec3 translation;
    Quat rotation;
    Vec3 scale;
};

struct Joint {
    std::string name;
    int parent_index = -1;
    Transform rest_local;
};

struct Skeleton {
    std::vector<Joint> joints;
    int root_index = 0;
};

struct JointPose {
    std::vector<Transform> local_transforms;
};

struct AnimationClip {
    std::string name;
    float duration_seconds = 0.0f;
    float frame_rate = 30.0f;
    // Track per joint, con identificazione stabile del joint.
};

enum class BlendMode {
    Override,
    Additive
};

struct AnimationLayer {
    std::string name;
    bool enabled = true;
    bool muted = false;
    float weight = 1.0f;
    BlendMode blend_mode = BlendMode::Override;
    // Riferimento al clip e maschera per joint.
};

enum class RootMotionMode {
    Full,
    InPlace,
    CustomPath
};
```

### Regole sui dati

-   Non usare l'indice di un joint come identificatore persistente tra
    skeleton differenti.
-   Usare un nome/ID stabile nel mapping e risolverlo in indice al
    caricamento.
-   Conservare la rest pose sorgente e target.
-   Documentare convenzioni di assi, unità, handedness e ordine
    quaternion.
-   Non applicare conversioni di coordinate in più punti della pipeline:
    definire un confine di conversione chiaro all'import.

------------------------------------------------------------------------

## 7. API interna prevista

Esempio di flusso d'uso desiderato:

``` cpp
auto character = load_glb("character.glb");

auto source_skeleton = load_native_skeleton(checkpoint);
auto target_skeleton = character.skeleton();

auto mapping = load_mapping("character_mapping.json");

auto generated = model.generate(
    "A character walking naturally"
);

auto motion = convert_to_animation_clip(generated);

apply_root_motion_mode(motion, RootMotionMode::InPlace);

auto retargeted = retarget(
    motion,
    source_skeleton,
    target_skeleton,
    mapping
);

AnimationStack stack(target_skeleton);
stack.add_layer(make_override_layer("Locomotion", retargeted));
stack.add_layer(make_additive_layer("UpperBody", upper_body_clip, upper_body_mask));

auto final_clip = stack.bake();

viewer.set_character(character);
viewer.set_animation(final_clip);

export_glb(
    "character_animation.glb",
    character,
    final_clip
);
```

Questo è il workflow API desiderato, non codice già presente o garantito
compilabile. Prima dell'implementazione occorre verificare le API
effettive di generazione, motion e skeleton del commit scelto.

------------------------------------------------------------------------

## 8. Viewer: responsabilità e comunicazione

### Frontend

Usare Three.js per:

-   caricamento e rendering GLB;
-   camera orbit/pan/zoom;
-   selezione joint;
-   skeleton helper;
-   playback e scrubbing;
-   visualizzazione del MotionPath;
-   pannelli layer e inspector.

### Backend C++

Il backend resta responsabile di:

-   inferenza;
-   decodifica motion;
-   post-processing root;
-   retargeting;
-   valutazione Animation Stack;
-   export.

### Trasporto dati

Per l'MVP usare un'interfaccia semplice coerente con la demo esistente:

1.  il frontend carica il modello e lo visualizza;
2.  il backend riceve prompt e opzioni di generazione;
3.  il backend restituisce un asset/clip serializzato;
4.  il frontend aggiorna la preview.

Per clip di dimensioni contenute può essere sufficiente un JSON o un
formato binario semplice. Evitare di inviare ogni frame via richieste
HTTP separate. In una fase successiva valutare WebSocket o streaming
binario se la preview live lo richiede.

Il viewer deve poter riprodurre localmente il clip già ricevuto, senza
richiedere una chiamata al backend per ogni frame.

------------------------------------------------------------------------

## 9. Dipendenze

Scegliere le dipendenze dopo aver verificato quelle già presenti e le
relative licenze.

  -----------------------------------------------------------------------
  Area                    Scelta iniziale         Nota
  ----------------------- ----------------------- -----------------------
  Rendering web           Three.js                Separato dal core C++

  GLB viewer              GLTFLoader              Incluso nell'ecosistema
                                                  Three.js

  GLB import C++          Assimp oppure parser    Valutare fedeltà a skin
                          glTF dedicato           e bind matrices

  GLB export              Libreria di scrittura   Verificare skin +
                          glTF                    animation

  FBX import futuro       ufbx o Assimp           Fuori scope MVP

  Math                    Primitive già presenti  Evitare duplicazioni
                          nel progetto            

  Test                    Framework già adottato  Aggiungere test unitari
                          dal repository          e regressione
  -----------------------------------------------------------------------

Per ogni dipendenza registrare versione, licenza, opzioni di build e
piattaforme supportate.

------------------------------------------------------------------------

## 10. Piano di implementazione

### Step 0 --- Audit e baseline

-   [ ] Clonare il repository e fissare il commit base.
-   [ ] Compilare il progetto senza modifiche.
-   [ ] Eseguire tutti i test esistenti.
-   [ ] Individuare API e strutture effettive di skeleton, motion e GLB.
-   [ ] Verificare cosa esporta oggi il demo.
-   [ ] Salvare un output di riferimento del percorso originale.
-   [ ] Registrare licenze di codice, checkpoint e dipendenze.

**Deliverable:** baseline riproducibile e nota tecnica sui punti
d'estensione reali.

### Step 1 --- Skeleton runtime e GLB viewer

-   [ ] Definire il modello interno Skeleton/Joint/Transform.
-   [ ] Implementare import GLB nel backend.
-   [ ] Implementare viewer Three.js.
-   [ ] Aggiungere skeleton overlay e selezione joint.
-   [ ] Aggiungere inspector read-only.
-   [ ] Creare uno o due asset GLB di test.

**Deliverable:** personaggio importato e visualizzato, senza animazione.

### Step 2 --- Root motion e MotionPath

-   [ ] Implementare modalità Full e InPlace.
-   [ ] Aggiungere test sulle coordinate root.
-   [ ] Implementare waypoints e Catmull--Rom.
-   [ ] Applicare il path alla root per frame.
-   [ ] Aggiungere orientamento lungo tangente.
-   [ ] Visualizzare il path nella viewport.

**Deliverable:** motion Kimodo in-place e motion che segue una
traiettoria esterna.

### Step 3 --- Retargeting

-   [ ] Implementare mapping manuale.
-   [ ] Implementare conversione rest-pose-aware.
-   [ ] Gestire scale e orientamenti dei bone.
-   [ ] Applicare motion al rig importato.
-   [ ] Visualizzare il risultato in viewport.
-   [ ] Aggiungere test con skeleton di proporzioni differenti.

**Deliverable:** animazione Kimodo riprodotta sulla mesh importata.

### Step 4 --- Animation Layers

-   [ ] Implementare AnimationClip e track.
-   [ ] Implementare layer Override.
-   [ ] Implementare layer Additive.
-   [ ] Implementare mask per joint.
-   [ ] Aggiungere preset Upper Body/Lower Body.
-   [ ] Implementare stack ordinato e valutazione.
-   [ ] Aggiungere UI per enable, mute e weight.
-   [ ] Aggiungere timeline playback/scrub.

**Deliverable:** più clip composti sullo stesso personaggio.

### Step 5 --- Export e regressione

-   [ ] Esportare GLB con mesh, skin e clip.
-   [ ] Riaprire l'export nel viewer.
-   [ ] Confrontare preview ed export.
-   [ ] Verificare che il percorso originale Kimodo sia invariato.
-   [ ] Documentare limiti noti e asset di test.

**Deliverable:** workflow completo prompt → retarget → layers → preview
→ GLB.

------------------------------------------------------------------------

## 11. Test e Definition of Done

L'MVP è considerato completato quando:

1.  il progetto originale continua a compilare e i test preesistenti
    passano;
2.  un GLB riggato viene importato e visualizzato;
3.  lo skeleton è ispezionabile e i joint sono selezionabili;
4.  un motion Kimodo può essere riprodotto in modalità Full e InPlace;
5.  un MotionPath waypoints/Catmull--Rom modifica la traiettoria root;
6.  un motion può essere retargettato su un rig umanoide compatibile;
7.  due o più Animation Layers possono essere composti;
8.  una maschera Upper Body impedisce al layer di modificare le gambe;
9.  peso, enable e mute producono risultati verificabili;
10. il risultato viene visualizzato nella viewport;
11. l'export GLB si riapre con mesh, skin e animazione;
12. le nuove feature sono opzionali e non cambiano il comportamento
    originale se disabilitate.

### Test specifici importanti

-   percorso vuoto, un solo punto e punti coincidenti;
-   tangente nulla e loop;
-   root iniziale non nulla;
-   assi up/forward differenti;
-   quaternion identità, rotazioni prossime a 180° e interpolazione;
-   joint mancanti nel mapping;
-   mapping con parent incompatibili;
-   clip con frame rate e durate differenti;
-   layer con peso 0 e 1;
-   maschera vuota e maschera completa;
-   additive layer con reference pose esplicita;
-   round-trip export/import GLB.

------------------------------------------------------------------------

## 12. Future Features --- backlog fuori dall'MVP

Questa sezione raccoglie le feature desiderate, senza bloccare la prima
release.

### F1 --- MotionPath avanzato

-   Curve Bezier e spline parametriche.
-   Controllo velocità per segmento.
-   Accelerazione/decelerazione.
-   Pause e waypoint con dwell time.
-   Path constraints durante la generazione AI.
-   Sincronizzazione stride frequency / path speed.
-   Motion warping e correzione dei passi.

### F2 --- AI Motion Conditioning

-   Passare al denoiser una rappresentazione del percorso.
-   Trajectory embedding e cross-attention.
-   Joint-level constraints.
-   Keyframe e target spaziali come conditioning.
-   Guidance durante la diffusione.
-   Dataset conversion e fine-tuning del modello.

Richiede una valutazione della disponibilità dei dati di training, della
compatibilità dei checkpoint e delle licenze.

### F3 --- Skeleton universale e generazione nativa

-   Skeleton descriptor con gerarchia e attributi anatomici.
-   Rappresentazione a numero variabile di joint.
-   Joint/spatial embeddings.
-   Denoiser skeleton-aware.
-   Supporto a rig non umanoidi.
-   Training o fine-tuning su skeleton eterogenei.

### F4 --- Animation Layers avanzati

-   Layer Procedural.
-   Layer Multiply con semantica definita per tipo di trasformazione.
-   Layer mask con pesi per joint e falloff gerarchico.
-   Curve di weight nel tempo.
-   Layer groups e dipendenze.
-   Animation graph e state machine.
-   Keyframe editing.
-   Retiming e time warping.
-   Layer generati da prompt indipendenti.

### F5 --- IK e qualità del movimento

-   Two Bone IK.
-   FABRIK.
-   Foot locking e ground contact.
-   Hand/prop constraints.
-   Look-at.
-   Collision e penetration correction.
-   Motion smoothing.
-   Balance e center-of-mass constraints.

### F6 --- Viewer ed editor avanzato

-   Gizmo 3D per trasformazioni e target.
-   Manipolazione del MotionPath nel viewport.
-   Selezione multipla di joint.
-   Pannello proprietà completo.
-   Timeline con keyframe.
-   Curve editor.
-   Visualizzazione pesi delle maschere sullo skeleton.
-   Confronto side-by-side tra motion originale e modificato.
-   Undo/redo e salvataggio progetto.

### F7 --- Formati e integrazioni

-   Import FBX.
-   Export FBX.
-   Blender integration.
-   Unity integration.
-   Unreal integration.
-   API Python.
-   Formato progetto nativo per salvare scene, mapping, layer, path e
    configurazioni.

### F8 --- Animation tools

-   Retargeting tra più personaggi.
-   Motion blending tra clip.
-   Motion matching.
-   Motion library.
-   Procedural locomotion.
-   Batch generation.
-   Generazione di varianti e random seed management.

------------------------------------------------------------------------

## 13. Rischi tecnici e mitigazioni

  -----------------------------------------------------------------------
  Rischio                             Mitigazione
  ----------------------------------- -----------------------------------
  Differenze di assi e rest pose      Conversione esplicita e test
                                      dedicati

  Retargeting innaturale              Limitare l'MVP a rig umanoidi
                                      compatibili

  Foot sliding sul path               Dichiarare il limite iniziale;
                                      IK/warping nel backlog

  Export GLB incompleto               Test round-trip su skin e
                                      animazioni prima di scegliere la
                                      libreria

  Duplicazione dei tipi Skeleton      Audit iniziale e adapter verso i
                                      tipi esistenti

  Regressioni nel core AI             Moduli additivi e test parity

  Viewer e backend fuori sincrono     Un solo formato di clip e
                                      convenzioni documentate

  Licenze dei checkpoint              Audit separato da quello del codice
                                      sorgente
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 14. Decisioni da non anticipare

Per non sovra-ingegnerizzare l'MVP, rimandare queste decisioni finché
non esistono test e casi d'uso concreti:

-   architettura definitiva del denoiser skeleton-aware;
-   formato binario proprietario per streaming;
-   supporto a skeleton arbitrari;
-   framework completo per procedural animation;
-   sistema di plugin per layer;
-   editor visuale paragonabile a Blender;
-   compatibilità completa FBX in import ed export.

------------------------------------------------------------------------

## 15. Riferimenti

-   Repository: https://github.com/localai-org/kimodo.cpp
-   Three.js: https://threejs.org/docs/
-   glTF: https://www.khronos.org/gltf/
-   Assimp: https://github.com/assimp/assimp
-   ufbx: https://github.com/ufbx/ufbx

Prima di iniziare l'implementazione, verificare README, API, CMake,
struttura demo, dipendenze e licenze sul commit effettivamente
selezionato. I nomi dei file in questo documento sono una proposta
organizzativa, non una garanzia che tutti esistano già o che le API
mostrate corrispondano a quelle correnti.

------------------------------------------------------------------------

## 16. Sintesi

Il primo rilascio deve dimostrare un flusso completo e limitato:

**Import GLB → visualizzazione mesh → generazione Kimodo →
InPlace/MotionPath → retargeting → Animation Layers → preview → export
GLB.**

Il valore dell'MVP non è supportare qualsiasi rig o fare conditioning AI
avanzato. È dimostrare che il motion generato da Kimodo può essere
controllato, applicato a un personaggio esterno, composto con altri
layer e verificato visivamente, senza compromettere il motore originale.

Tutto il resto rimane nel backlog Future Features e potrà essere
implementato in modo incrementale.
