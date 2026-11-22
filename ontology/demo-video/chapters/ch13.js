// Closing slide.
module.exports = {
  n: 13, title: 'Summary', slides: true, tail: 1800,
  prepare: async c => { await c.slide(9); },
  beats: [
    { say: "That is the whole journey: from a blank page to a tested, explainable ontology, connected to your data and your documents, and ready to share. OntoStudio gives every team one shared language, and gives your AI something solid to stand on.",
      act: async c => { c.at(0.05, () => c.reveal(9, 1)); c.at(0.55, () => c.reveal(9, 2)); } },
    { say: "Start with a pre-built ontology, or bring your own data and documents. Thanks for watching.",
      act: async c => { c.at(0.3, () => c.reveal(9, 3)); } },
  ],
};
