CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"category" text NOT NULL,
	"folder" text NOT NULL,
	"subfolder" text DEFAULT '' NOT NULL,
	"r2_key" text NOT NULL,
	"content_type" text DEFAULT 'application/pdf' NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"uploaded_by" text NOT NULL,
	"uploaded_by_name" text DEFAULT '' NOT NULL,
	"created_at" text DEFAULT now()::text NOT NULL,
	CONSTRAINT "documents_r2_key_unique" UNIQUE("r2_key"),
	CONSTRAINT "documents_category_check" CHECK ("category" IN ('certificates', 'loose')),
	CONSTRAINT "documents_folder_check" CHECK (
		("category" = 'certificates' AND "folder" = 'certificados' AND "subfolder" IN ('garantia_produto', 'garantia_estendida')) OR
		("category" = 'loose' AND "folder" = 'documentos_avulsos' AND "subfolder" = '')
	),
	CONSTRAINT "documents_content_type_check" CHECK ("content_type" = 'application/pdf'),
	CONSTRAINT "documents_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400)
);
--> statement-breakpoint
CREATE INDEX "documents_folder_created_idx" ON "documents" USING btree ("folder","subfolder","created_at");--> statement-breakpoint
CREATE INDEX "documents_uploaded_by_idx" ON "documents" USING btree ("uploaded_by");--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "documents" FROM anon, authenticated;
