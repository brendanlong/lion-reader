package com.lionreader.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Loading skeleton for a single entry list item.
 *
 * Mimics the structure of EntryListItem with shimmer placeholders
 * for feed title, entry title, summary, and metadata.
 */
@Composable
fun EntryListItemSkeleton(
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
        ) {
            // Feed title placeholder
            ShimmerLine(
                modifier = Modifier
                    .height(12.dp)
                    .width(80.dp),
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Entry title placeholder (2 lines)
            ShimmerLine(
                modifier = Modifier
                    .height(18.dp)
                    .fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(6.dp))

            ShimmerLine(
                modifier = Modifier
                    .height(18.dp)
                    .fillMaxWidth(0.7f),
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Summary placeholder (2 lines)
            ShimmerLine(
                modifier = Modifier
                    .height(14.dp)
                    .fillMaxWidth(),
            )

            Spacer(modifier = Modifier.height(4.dp))

            ShimmerLine(
                modifier = Modifier
                    .height(14.dp)
                    .fillMaxWidth(0.85f),
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Footer: date and actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Date placeholder
                ShimmerLine(
                    modifier = Modifier
                        .height(12.dp)
                        .width(60.dp),
                )

                // Action buttons placeholder
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ShimmerCircle(
                        modifier = Modifier.size(24.dp),
                    )
                    ShimmerCircle(
                        modifier = Modifier.size(24.dp),
                    )
                }
            }
        }
    }
}

/**
 * Loading skeleton for the entry list screen.
 *
 * Displays multiple EntryListItemSkeleton elements to indicate
 * the list is loading.
 *
 * @param itemCount Number of skeleton items to display
 * @param modifier Modifier for the list
 */
@Composable
fun EntryListSkeleton(
    modifier: Modifier = Modifier,
    itemCount: Int = 5,
) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(vertical = 8.dp),
        userScrollEnabled = false,
    ) {
        items(itemCount) {
            EntryListItemSkeleton()
        }
    }
}

/**
 * Loading skeleton for the entry detail screen.
 *
 * Mimics the structure of EntryDetailContent with shimmer placeholders
 * for feed title, entry title, metadata, and article content.
 */
@Composable
fun EntryDetailSkeleton(
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 16.dp),
    ) {
        // Feed title placeholder
        ShimmerLine(
            modifier = Modifier
                .height(14.dp)
                .width(100.dp),
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Entry title placeholder (multiple lines for long titles)
        ShimmerLine(
            modifier = Modifier
                .height(28.dp)
                .fillMaxWidth(),
        )

        Spacer(modifier = Modifier.height(8.dp))

        ShimmerLine(
            modifier = Modifier
                .height(28.dp)
                .fillMaxWidth(0.8f),
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Meta row: author and date
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ShimmerLine(
                modifier = Modifier
                    .height(14.dp)
                    .width(80.dp),
            )
            ShimmerLine(
                modifier = Modifier
                    .height(14.dp)
                    .width(100.dp),
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Article content placeholder (multiple paragraphs)
        repeat(3) {
            ContentParagraphSkeleton()
            Spacer(modifier = Modifier.height(20.dp))
        }

        // Image placeholder
        ShimmerBox(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp),
            shape = RoundedCornerShape(8.dp),
        )

        Spacer(modifier = Modifier.height(20.dp))

        // More content
        repeat(2) {
            ContentParagraphSkeleton()
            Spacer(modifier = Modifier.height(20.dp))
        }
    }
}

/**
 * A paragraph placeholder for article content.
 */
@Composable
private fun ContentParagraphSkeleton() {
    Column {
        ShimmerLine(
            modifier = Modifier
                .height(16.dp)
                .fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(6.dp))
        ShimmerLine(
            modifier = Modifier
                .height(16.dp)
                .fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(6.dp))
        ShimmerLine(
            modifier = Modifier
                .height(16.dp)
                .fillMaxWidth(0.92f),
        )
        Spacer(modifier = Modifier.height(6.dp))
        ShimmerLine(
            modifier = Modifier
                .height(16.dp)
                .fillMaxWidth(0.65f),
        )
    }
}

/**
 * Loading skeleton for a drawer navigation item.
 */
@Composable
fun DrawerItemSkeleton(
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 28.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Icon placeholder
        ShimmerCircle(
            modifier = Modifier.size(24.dp),
        )

        Spacer(modifier = Modifier.width(16.dp))

        // Label placeholder
        ShimmerLine(
            modifier = Modifier
                .height(16.dp)
                .weight(1f),
        )

        Spacer(modifier = Modifier.width(12.dp))

        // Badge placeholder
        ShimmerBox(
            modifier = Modifier
                .height(20.dp)
                .width(28.dp),
            shape = RoundedCornerShape(10.dp),
        )
    }
}

/**
 * Loading skeleton for the navigation drawer.
 *
 * Displays skeleton items for the drawer header and navigation items.
 */
@Composable
fun DrawerSkeleton(
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize(),
    ) {
        // Header placeholder
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(120.dp)
                .shimmerEffect(RoundedCornerShape(0.dp)),
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Main navigation items (All, Starred)
        repeat(2) {
            DrawerItemSkeleton()
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Section label placeholder
        ShimmerLine(
            modifier = Modifier
                .padding(horizontal = 28.dp)
                .height(12.dp)
                .width(40.dp),
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Tags section items
        repeat(3) {
            DrawerItemSkeleton()
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Section label placeholder
        ShimmerLine(
            modifier = Modifier
                .padding(horizontal = 28.dp)
                .height(12.dp)
                .width(40.dp),
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Feeds section items
        repeat(4) {
            DrawerItemSkeleton()
        }
    }
}
