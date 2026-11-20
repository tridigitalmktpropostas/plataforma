# Loja e histórico de compras da área do cliente MIV

Este guia explica como cadastrar os próximos produtos digitais da Tri Digital para que apareçam na aba **Outros produtos** da área do cliente, sejam vendidos pela Kiwify e tenham o acesso liberado automaticamente.

## Como funciona

- A pessoa continua entrando na área do cliente com a chave original do MIV.
- O servidor valida essa chave e usa o e-mail associado à compra original para localizar as compras adicionais.
- Compras adicionais aprovadas chegam pelo webhook Kiwify e são registradas em `public.miv_customer_purchases`.
- O histórico de compras mostra o MIV original e os produtos adicionais.
- O catálogo em `public.miv_products` define nome, descrição, imagem, checkout e o destino do conteúdo.
- Se o webhook Kiwify enviar um link individual `access_url`, o sistema o guarda para aquele pedido e libera o botão **Acessar produto** após a aprovação.
- Para produtos sem link individual da Kiwify, cadastrar `access_url` no catálogo.
- Reembolso e chargeback atualizam o pedido e removem a liberação do produto na próxima atualização da área do cliente.

Não são geradas novas chaves MIV para produtos adicionais e a IA não é executada novamente.

## 1. Cadastrar o produto antes de começar a vender

Crie o produto na Kiwify e copie o ID do produto. Na documentação de ajuda da Kiwify, o ID aparece na URL da edição do produto, depois de `edit/`.

No SQL Editor do projeto Supabase, execute um cadastro como este, substituindo os valores de exemplo:

```sql
insert into public.miv_products (
  kiwify_product_id,
  slug,
  title,
  short_description,
  description,
  cover_image_url,
  checkout_url,
  access_url,
  access_instructions,
  is_published,
  display_order
) values (
  'COLE_AQUI_O_ID_DO_PRODUTO_NA_KIWIFY',
  'nome-do-produto',
  'Nome do novo produto',
  'Uma frase curta que explica o benefício do produto.',
  'Descrição completa do material ou experiência.',
  'https://seu-dominio.com.br/imagens/capa-produto.jpg',
  'https://pay.kiwify.com.br/SEU_CHECKOUT',
  null,
  'As instruções de acesso aparecerão aqui quando o produto estiver liberado.',
  false,
  20
)
on conflict (kiwify_product_id) do update set
  slug = excluded.slug,
  title = excluded.title,
  short_description = excluded.short_description,
  description = excluded.description,
  cover_image_url = excluded.cover_image_url,
  checkout_url = excluded.checkout_url,
  access_url = excluded.access_url,
  access_instructions = excluded.access_instructions,
  is_published = excluded.is_published,
  display_order = excluded.display_order,
  updated_at = now();
```

O produto fica registrado com `is_published = false`: assim, o webhook já consegue reconhecer seu ID antes da primeira compra quando a variável `KIWIFY_PRODUCT_ID` não estiver configurada, mas o produto ainda não aparece na vitrine.

## 2. Configurar o webhook da Kiwify

Na configuração de Webhooks da Kiwify, use o mesmo endpoint e o mesmo segredo/token que já atendem o MIV. Inclua o novo produto na seleção de produtos desse webhook e habilite os eventos de:

- Compra aprovada.
- Reembolso.
- Chargeback.

A Kiwify permite selecionar produtos e eventos na configuração do webhook. Os eventos são enviados por POST e a Kiwify pode reenviar uma notificação que não receba resposta 2xx.

**Importante:** não substitua o webhook existente do MIV por outro endpoint. Amplie a seleção do webhook atual ou mantenha um webhook adicional apontando para o mesmo endpoint e a mesma autenticação.

O webhook usa `Product.product_id`, `Product.product_name`, `Customer.email`, `Commissions.charge_amount` e `Commissions.currency`. O valor `charge_amount` é recebido em centavos. O campo `access_url`, quando enviado pela Kiwify, é salvo como endereço individual daquela compra.

## 3. Publicar o conteúdo e liberar o acesso

Quando o conteúdo estiver pronto, configure o destino:

**Produto com acesso individual fornecido pela Kiwify:** o link recebido no webhook é salvo por pedido e apresentado automaticamente depois que a compra é aprovada. Ainda é possível preencher `access_url` no catálogo como alternativa.

**Produto com conteúdo hospedado pela Tri Digital ou em outra plataforma:** preencha `access_url` com o endereço HTTPS da página, arquivo ou experiência. Caminhos internos do site que começam com `/` também são aceitos.

Depois, publique o produto:

```sql
update public.miv_products
   set access_url = 'https://seu-dominio.com.br/area-do-produto',
       access_instructions = 'Clique em Acessar produto para abrir seu material.',
       is_published = true,
       updated_at = now()
 where kiwify_product_id = 'COLE_AQUI_O_ID_DO_PRODUTO_NA_KIWIFY';
```

A partir daí:
- Quem já comprou e tem pedido pago verá **Acessar produto**.
- Quem ainda não comprou verá **Conhecer e comprar**, apontando para o checkout.
- Quem comprou, mas ainda não recebeu um destino de conteúdo válido, verá **Acesso em preparação**.
- Um reembolso ou chargeback retira o acesso após a atualização do status do pedido.

## 4. Histórico e conferência de pedidos

Para conferir os pedidos adicionais recebidos:

```sql
select
  buyer_email,
  kiwify_order_id,
  kiwify_product_id,
  product_name,
  purchase_status,
  amount,
  currency,
  purchased_at,
  provider_access_url
from public.miv_customer_purchases
order by purchased_at desc nulls last, created_at desc;
```

Para conferir os produtos publicados:

```sql
select
  kiwify_product_id,
  slug,
  title,
  is_published,
  checkout_url,
  access_url,
  display_order
from public.miv_products
order by display_order, title;
```

## Regras importantes

1. O comprador deve usar na Kiwify o mesmo e-mail da compra original do MIV para que os pedidos sejam agrupados na mesma área do cliente.
2. Cadastre o ID do produto antes de começar a divulgar o checkout, principalmente se `KIWIFY_PRODUCT_ID` não estiver definido na Vercel.
3. Não marque `is_published = true` enquanto o conteúdo não estiver pronto.
4. A tabela de compras não guarda o payload bruto do webhook, dados de cartão ou informações de pagamento desnecessárias.
5. O catálogo e o histórico não ficam expostos diretamente ao navegador: a API valida a chave MIV e consulta o Supabase no servidor.
6. Produtos adicionais não criam outra chave de acesso e não alteram o diagnóstico original.

## Estrutura de dados

- `miv_products`: catálogo controlado pela Tri Digital.
- `miv_customer_purchases`: histórico mínimo de compras adicionais recebidas da Kiwify.
- `miv_access_keys`: continua sendo a origem do acesso MIV e do histórico da compra original.

As duas novas tabelas mantêm RLS habilitado e não concedem leitura a `anon` ou `authenticated`. O acesso é feito exclusivamente pela API com a credencial privada do servidor.
