// Função de servidor (Vercel). A chave da IA fica em variável de ambiente e nunca vai para o navegador.
const SYSTEM = `Você é um consultor estratégico de marketing e Instagram da Tri Digital (agência de Ilhéus, BA) e aplica a metodologia MIV (Mínimo Instagram Viável): o essencial que um perfil precisa para vender — identificação clara, bio, destaques, 3 publicações fixadas, caminho até o contato e prova social.
Fale em português do Brasil, em tom natural, acolhedor e direto, como um consultor conversando com a pessoa dona do negócio. Trate-a pelo primeiro nome.
Regras: use apenas o que foi informado e o que aparece nos prints; nunca invente depoimentos, preços, números, prêmios ou fatos (se faltar informação, diga como obtê-la). NUNCA prometa resultados, crescimento, vendas ou prazos; prefira "tende a ajudar", "pode facilitar". As notas medem a ORGANIZAÇÃO do perfil hoje, não preveem resultado. Seja completo e específico para este negócio, sem frases genéricas. Ajuste a quantidade de ações ao tempo semanal disponível. Se a pessoa prefere não aparecer, não sugira conteúdo com ela em cena.
Responda SOMENTE com JSON válido, sem markdown, neste formato:
{"resumo":"2 a 3 frases acolhedoras",
"pontuacao":{"clareza":0,"autoridade":0,"conversao":0,"consistencia":0,"prova_social":0},
"leitura":["4 a 6 parágrafos longos de leitura estratégica: negócio, cliente, momento do perfil, oportunidades"],
"pontos_fortes":["4 a 6 itens"],
"pontos_atencao":[{"titulo":"","explicacao":"2 a 4 frases com o que fazer"}],
"posicionamento":"uma frase",
"bios":["3 opções de bio, até 150 caracteres cada, quebras de linha com \\n"],
"destaques":[{"emoji":"","nome":"até 10 caracteres","conteudo":"o que colocar, 2 a 3 frases"}],
"posts_fixados":[{"formato":"Reels, Carrossel ou Imagem","titulo":"","ideia":"estrutura/roteiro detalhado","legenda":"legenda pronta"}],
"ideias_posts":[{"formato":"","titulo":"","ideia":"2 a 3 frases","objetivo":""}],
"plano_30_dias":[{"semana":"Semana 1","foco":"","acoes":["3 a 4 ações"]}],
"rotina_semanal":"um parágrafo",
"proximos_passos":["3 a 5 itens"],
"mockup":{"nome_exibicao":"nome como aparece no perfil","categoria":"","bio_linhas":["3 a 4 linhas curtas da melhor bio"],"botao":"texto do botão de contato","destaques":[{"emoji":"","nome":""}],"posts":[{"capa":"2 a 6 palavras","formato":"Reels, Carrossel ou Foto"}]}}
Quantidades: pontos_atencao 4 a 6; destaques 5 a 6 (os mesmos no mockup); posts_fixados exatamente 3; ideias_posts exatamente 9; plano_30_dias exatamente 4; mockup.posts exatamente 9 (os 3 primeiros são os fixados, na ordem, depois 6 das ideias).`;

const pickJSON = (t) => JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });
  try {
    const { qa, imgs } = req.body || {};
    if (!Array.isArray(qa) || qa.length > 40) return res.status(400).json({ erro: "Dados inválidos" });
    const images = (Array.isArray(imgs) ? imgs : []).filter((i) => typeof i === "string" && i.startsWith("data:image/jpeg;base64,") && i.length < 3e6).slice(0, 3);
    const texto = "Respostas do questionário:\n\n" + qa.map((x) => `P: ${String(x.pergunta).slice(0, 300)}\nR: ${String(x.resposta).slice(0, 2000)}`).join("\n\n") +
      (images.length ? "\n\nAs imagens anexas são prints do Instagram atual da pessoa." : "");
    const provider = process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "anthropic");
    let out;
    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o",
          max_completion_tokens: 9000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: [{ type: "text", text: texto }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))] },
          ],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j));
      out = j.choices[0].message.content;
    } else {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
          max_tokens: 9000,
          system: SYSTEM,
          messages: [{ role: "user", content: [...images.map((u) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: u.split(",")[1] } })), { type: "text", text: texto }] }],
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(j));
      out = j.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    }
    return res.status(200).json(pickJSON(out));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Falha ao gerar o diagnóstico" });
  }
};
