# MIV · Tri Digital — como colocar no ar

Estrutura: `index.html` (o site) + `api/diagnostico.js` (servidor que fala com a IA) + `vercel.json`.
A chave da IA fica só no servidor. Nunca coloque a chave dentro do HTML.

## Publicar na Vercel (gratuito para começar)
1. Crie uma conta em vercel.com e envie esta pasta (pelo GitHub ou `npx vercel` no terminal).
2. Em Settings → Environment Variables, adicione:
   - `OPENAI_API_KEY` (chave do ChatGPT/OpenAI) e, se quiser, `OPENAI_MODEL` com o modelo atual
   - OU `ANTHROPIC_API_KEY` (Claude). Para forçar um provedor: `AI_PROVIDER` = `openai` ou `anthropic`
3. Faça o deploy e conecte seu domínio em Settings → Domains.

## Antes de vender
- Cada diagnóstico gera custo de IA. Coloque o acesso atrás do pagamento (link de pagamento + código de acesso) ou limite o uso, senão qualquer pessoa pode gastar seu crédito.
- O diagnóstico leva de 30 s a 2 min; o limite da função está em 60 s. Se estourar, use o plano com mais tempo ou um modelo mais rápido.
- Você coleta dados pessoais e prints: publique política de privacidade (LGPD) e deixe claro que o texto é gerado por IA.
- Teste com 2 ou 3 negócios reais e ajuste o texto do `SYSTEM` em `api/diagnostico.js` para refinar o tom.
